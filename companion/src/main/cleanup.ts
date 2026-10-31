/**
 * Clean up for ended sessions. Lists what a session left behind and what keeps each thing,
 * then moves what you discard to the Trash. Nothing here runs unless you ask.
 *
 * Kept: a feedback file whose output is tracked in git or listed in an initiative's Outputs,
 * a board another session holds or the panel has open, and anything you kept before.
 */

import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { outputsFile, type Initiative } from '../protocol';
import { itemsFile } from '../server/index';
import { draftKind, draftTitle } from '../shared/drafts';
import { feedbackAssets, feedbackPath, parseFeedback } from '../shared/feedback';
import type { CleanupItem, CleanupResult, Draft, KeepReason } from '../shared/ipc';
import { parseOutputsFile } from '../shared/output-file';
import { isUrlRef } from '../shared/outputs';
import { readCapped, writeAtomic } from './files';
import { outputRowTarget } from './initiative-markdown';
import { heldBoards, type SessionBriefs } from './session-briefs';

export interface CleanupDeps {
  dataDir: string;
  briefs: () => SessionBriefs;
  isLive: (sessionId: string) => boolean;
  drafts: () => Draft[];
  draftFile: (id: string) => string;
  boardFiles: (name: string) => string[];
  currentBoard: () => string | undefined;
  initiatives: () => Initiative[];
  /** The absolute paths among `files` that git tracks in `cwd`. */
  tracked: (cwd: string, files: string[]) => Promise<Set<string>>;
  trash: (path: string) => Promise<void>;
  /** These run once an item's files are gone, so stores and views forget it. */
  forgetDraft: (id: string) => void;
  forgetBoard: (name: string) => void;
  feedbackGone: (cwd: string, output: string) => void;
}

/** A plan entry with the files behind it, which never leave main. */
interface Planned extends CleanupItem {
  files: string[];
  cwd?: string;
}

const KEPT_FILE = 'kept.json';

export class Cleanup {
  constructor(private readonly deps: CleanupDeps) {}

  async plan(sessionIds: unknown): Promise<CleanupItem[]> {
    return (await this.planned(strings(sessionIds))).map(({ files: _files, cwd: _cwd, ...item }) => item);
  }

  /** Builds the plan again, so only items it still lists and does not keep go to the Trash. */
  async run(discard: unknown, keep: unknown): Promise<CleanupResult> {
    const ids = new Set(strings(discard));
    const items = (await this.planned(Object.keys(this.deps.briefs()))).filter((i) => ids.has(i.id) && !i.keep);
    let bytes = 0;
    for (const item of items) {
      for (const file of item.files) if (existsSync(file)) await this.deps.trash(file);
      bytes += item.bytes;
      this.forget(item);
    }
    const kept = strings(keep);
    if (kept.length) this.saveKept([...this.kept(), ...kept]);
    return { trashed: items.length, bytes };
  }

  private forget(item: Planned): void {
    const key = item.id.slice(item.id.indexOf(':') + 1);
    if (item.kind === 'note') this.deps.forgetDraft(key);
    else if (item.kind === 'board') this.deps.forgetBoard(key);
    else if (item.kind === 'feedback' && item.cwd) this.deps.feedbackGone(item.cwd, relative(item.cwd, key));
  }

  private async planned(sessionIds: readonly string[]): Promise<Planned[]> {
    const briefs = this.deps.briefs();
    const kept = this.kept();
    const drafts = this.deps.drafts();
    const outputs = new Set(this.deps.initiatives().flatMap((i) => (i.outputs ?? []).flatMap((row) => outputRowTarget(row) ?? [])));
    const items: Planned[] = [];
    for (const sessionId of sessionIds) {
      const brief = briefs[sessionId];
      if (!brief || this.deps.isLive(sessionId)) continue;
      const mine = drafts.filter((d) => d.sessionId === sessionId);
      items.push(...mine.map((d) => this.note(d, sessionId, kept)));
      items.push(...this.boards(sessionId, briefs, kept));
      if (!brief.cwd) continue;
      const itemsPath = itemsFile(brief.cwd, sessionId);
      if (existsSync(itemsPath)) items.push({ id: `items:${sessionId}`, sessionId, kind: 'items', label: 'Items file', bytes: bytesOf(itemsPath), files: [itemsPath] });
      items.push(...(await this.feedback(sessionId, brief.cwd, mine, kept, outputs)));
    }
    // A board two ended sessions held lists once.
    return items.filter((item, i) => items.findIndex((x) => x.id === item.id) === i);
  }

  private note(d: Draft, sessionId: string, kept: Set<string>): Planned {
    const id = `note:${d.id}`;
    const kind = draftKind(d);
    const name = d.title || draftTitle(d.body) || 'Untitled note';
    const label = kind === 'review' ? `Review · ${d.review!.path}` : kind === 'outline' ? `Outline note · ${d.outline!.path}` : name;
    const file = this.deps.draftFile(d.id);
    return { id, sessionId, kind: 'note', label, bytes: bytesOf(file), files: [file], ...keepIf(kept.has(id) && 'kept') };
  }

  private boards(sessionId: string, briefs: SessionBriefs, kept: Set<string>): Planned[] {
    const brief = briefs[sessionId]!;
    const others = Object.entries(briefs).filter(([id]) => id !== sessionId).flatMap(([, b]) => heldBoards(b));
    return heldBoards(brief).flatMap((name) => {
      let files: string[];
      try { files = this.deps.boardFiles(name); } catch { return []; }
      const id = `board:${name}`;
      const keep: KeepReason | false = (kept.has(id) && 'kept') || (others.includes(name) && 'shared') || (this.deps.currentBoard() === name && 'open');
      return [{ id, sessionId, kind: 'board' as const, label: `Board · ${name}`, bytes: files.reduce((n, f) => n + bytesOf(f), 0), files, ...keepIf(keep) }];
    });
  }

  /** Feedback on the files the session declared, wrote or reviewed. */
  private async feedback(sessionId: string, cwd: string, mine: Draft[], kept: Set<string>, initiativeOutputs: Set<string>): Promise<Planned[]> {
    const record = parseOutputsFile(readCapped(outputsFile(cwd, sessionId), 'outputs record', 4 * 1024 * 1024) ?? '');
    const refs = [...(record?.outputs.map((o) => o.ref) ?? []), ...mine.flatMap((d) => (d.review ? [d.review.path] : []))];
    const outputs = [...new Set(refs.filter((r) => !isUrlRef(r)).map((r) => resolve(cwd, r)))].filter((o) => existsSync(feedbackPath(o)));
    if (!outputs.length) return [];
    const tracked = await this.deps.tracked(cwd, outputs.flatMap((o) => [o, feedbackPath(o)]));
    return outputs.map((output) => {
      const id = `feedback:${output}`;
      const assets = feedbackAssets(output);
      const files = [feedbackPath(output), ...(existsSync(assets) ? [assets] : [])];
      const pictures = existsSync(assets) ? readdirSync(assets).filter((f) => !f.startsWith('.')).length : 0;
      const keep: KeepReason | false =
        (kept.has(id) && 'kept') || ((tracked.has(output) || tracked.has(feedbackPath(output))) && 'git') || (initiativeOutputs.has(output) && 'initiative');
      return {
        id,
        sessionId,
        cwd,
        kind: 'feedback' as const,
        label: `Feedback on ${relative(cwd, output)}`,
        detail: [plural(itemCount(feedbackPath(output)), 'item'), ...(pictures ? [plural(pictures, 'picture')] : [])].join(' · '),
        bytes: files.reduce((n, f) => n + bytesOf(f), 0),
        files,
        ...keepIf(keep),
      };
    });
  }

  private kept(): Set<string> {
    try {
      const list = JSON.parse(readFileSync(join(this.deps.dataDir, KEPT_FILE), 'utf8'));
      return new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : []);
    } catch {
      return new Set();
    }
  }

  private saveKept(ids: string[]): void {
    writeAtomic(join(this.deps.dataDir, KEPT_FILE), JSON.stringify([...new Set(ids)], null, 2));
  }
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []);

const keepIf = (keep: KeepReason | false | undefined) => (keep ? { keep } : {});

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

function itemCount(file: string): number {
  try {
    return parseFeedback(readFileSync(file, 'utf8')).items.length;
  } catch {
    return 0;
  }
}

/** A file's size, or a folder's total. */
function bytesOf(path: string): number {
  try {
    const s = statSync(path);
    if (!s.isDirectory()) return s.size;
    return readdirSync(path).reduce((n, name) => n + bytesOf(join(path, name)), 0);
  } catch {
    return 0;
  }
}

/** The absolute paths among `files` that git tracks in `cwd`. Empty outside a repository. */
export function gitTracked(cwd: string, files: string[]): Promise<Set<string>> {
  return new Promise((done) => {
    execFile('git', ['-C', cwd, 'ls-files', '-z', '--', ...files.map((f) => relative(cwd, f))], { timeout: 5000 }, (err, stdout) => {
      done(err ? new Set() : new Set(stdout.split('\0').filter(Boolean).map((p) => join(cwd, p))));
    });
  });
}
