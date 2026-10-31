/**
 * Initiatives: briefs the PM keeps in their own folders, indexed in `<dataDir>/initiatives.json`.
 *
 * The index holds each brief's path, revision history, the hash of the text last seen,
 * lastActiveAt and the session bindings. A brief whose hash changed was edited outside
 * the app, and reading it records a revision by `PM`. A read-only store, as the CLI uses
 * with the app closed, reads the same files and never writes.
 */

import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import {
  INITIATIVE_UNDERSTANDING_CAP,
  type Initiative,
  type InitiativeCreateRequest,
  type InitiativeRevision,
  type InitiativeSnapshot,
  type InitiativeSummary,
  type InitiativeUpdateRequest,
  type OutputRecord,
} from '../protocol';
import { BoardError, badRequest, notFound } from '../board/errors';
import { isUrlRef } from '../shared/outputs';
import { shortPath } from '../shared/sessions';
import { briefFileName, changedFields, firstSentence, formatBrief, mergeOutputRows, newBrief, parseBrief, type BriefFields, type OutputLink, type ParsedBrief } from './initiative-markdown';
import { hash as sha, writeAtomic } from './files';

export const INITIATIVES_FILE = 'initiatives.json';

/** Revisions each initiative keeps. */
const MAX_REVISIONS = 200;
/** Session bindings the index keeps, the latest by attach time. */
const MAX_ATTACHMENTS = 500;
/** Files a search for a moved brief opens. */
const MAX_SCAN = 500;

interface IndexRow {
  id: string;
  title: string;
  path: string;
  createdAt: string;
  lastActiveAt: string;
  revision: number;
  updatedAt: string;
  updatedBy: string;
  /** sha256 of the brief as the app last wrote or read it. */
  hash: string;
  /** Oldest first. */
  revisions: InitiativeRevision[];
}

interface Attachment {
  /** Absent after a detach. The count stays, so the next attach still bumps it. */
  initiativeId?: string;
  attachmentRevision: number;
  at: string;
}

interface IndexFile {
  version: 1;
  initiatives: IndexRow[];
  attachments: Record<string, Attachment>;
}

interface Read {
  row: IndexRow;
  brief?: ParsedBrief;
}

/** `~/x` as an absolute path. */
export function expandHome(path: string, home = homedir()): string {
  return path === '~' ? home : path.startsWith('~/') ? join(home, path.slice(2)) : path;
}

/** The first bytes of a file, enough for its front matter. */
function headOf(path: string): string {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(512);
    return buf.subarray(0, readSync(fd, buf, 0, 512, 0)).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

// ── Matching ──────────────────────────────────────────────────────────────

const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'our', 'are', 'was', 'what', 'how', 'about', 'work', 'on', 'of', 'to', 'in', 'a', 'an', 'is', 'it']);

/** Lower-case words of two letters or more, a plural `s` dropped, stop words left out. */
export function terms(text: string): Set<string> {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return new Set(words.filter((w) => w.length > 1 && !STOP.has(w)).map((w) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w)));
}

/** Overlap between the query and an initiative: a title term counts 3, an Understanding or decision term 1 each. */
export function overlap(query: Set<string>, i: Pick<Initiative, 'title' | 'understanding' | 'decisions'>): number {
  const title = terms(i.title);
  const understanding = terms(i.understanding);
  const decisions = terms(i.decisions.join(' '));
  let score = 0;
  for (const t of query) score += (title.has(t) ? 3 : 0) + (understanding.has(t) ? 1 : 0) + (decisions.has(t) ? 1 : 0);
  return score;
}

/** Finds an initiative by id, then by title regardless of case, then by a title prefix only one matches. */
export function resolveInitiative<T extends { id: string; title: string }>(list: T[], key: string): T | undefined {
  const k = key.trim().toLowerCase();
  if (!k) return undefined;
  const exact = list.find((i) => i.id === key.trim()) ?? list.find((i) => i.title.toLowerCase() === k);
  if (exact) return exact;
  const prefixed = list.filter((i) => i.title.toLowerCase().startsWith(k));
  return prefixed.length === 1 ? prefixed[0] : undefined;
}

/** A session's declared, ready outputs as Outputs rows link them. A file links by its absolute path. */
export function readyOutputLinks(cwd: string, records: readonly OutputRecord[]): OutputLink[] {
  return records
    .filter((r) => r.tier === 'declared' && r.status === 'ready')
    .map((r) => {
      const url = r.url ?? (isUrlRef(r.ref) ? r.ref : undefined);
      if (url) return { title: r.title ?? url, url };
      const path = resolve(cwd, r.ref);
      return { title: r.title ?? basename(path), path };
    });
}

// ── Store ─────────────────────────────────────────────────────────────────

export interface InitiativeStoreOptions {
  now?: () => Date;
  /** Reads without recording edits, moves or anything else. */
  readOnly?: boolean;
  home?: string;
  /** The live session ids. When set, an initiative lists only its live sessions as attached. */
  liveSessions?: () => Iterable<string>;
}

export class InitiativeStore {
  private readonly path: string;
  private readonly now: () => Date;
  private readonly readOnly: boolean;
  private readonly home: string;
  private readonly liveSessions?: () => Iterable<string>;
  private index: IndexFile;
  private readonly listeners = new Set<() => void>();

  constructor(dataDir: string, opts: InitiativeStoreOptions = {}) {
    this.path = join(dataDir, INITIATIVES_FILE);
    this.now = opts.now ?? (() => new Date());
    this.readOnly = !!opts.readOnly;
    this.home = opts.home ?? homedir();
    this.liveSessions = opts.liveSessions;
    this.index = this.loadIndex();
  }

  private loadIndex(): IndexFile {
    try {
      const saved = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<IndexFile>;
      return { version: 1, initiatives: Array.isArray(saved.initiatives) ? saved.initiatives : [], attachments: saved.attachments ?? {} };
    } catch {
      return { version: 1, initiatives: [], attachments: {} };
    }
  }

  private save(): void {
    if (this.readOnly) return;
    const kept = Object.entries(this.index.attachments)
      .sort(([, a], [, b]) => b.at.localeCompare(a.at))
      .slice(0, MAX_ATTACHMENTS);
    this.index.attachments = Object.fromEntries(kept);
    mkdirSync(dirname(this.path), { recursive: true });
    writeAtomic(this.path, JSON.stringify(this.index, null, 2));
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  /** Fires after anything in the index or a brief changes. Returns an unsubscribe. */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private row(id: string): IndexRow {
    const row = this.index.initiatives.find((r) => r.id === id);
    if (!row) throw notFound(`no initiative ${id}`);
    return row;
  }

  private stamp(): string {
    return this.now().toISOString();
  }

  private addRevision(row: IndexRow, updatedBy: string, changed?: string[]): void {
    const updatedAt = this.stamp();
    row.revision += 1;
    row.updatedAt = updatedAt;
    row.updatedBy = updatedBy;
    row.revisions.push({ revision: row.revision, updatedAt, updatedBy, ...(changed ? { changed } : {}) });
    if (row.revisions.length > MAX_REVISIONS) row.revisions.splice(0, row.revisions.length - MAX_REVISIONS);
  }

  /** Looks for a brief with this id beside its old path, then in the folders next to that one. */
  private relocate(row: IndexRow): string | undefined {
    const dir = dirname(row.path);
    const parent = dirname(dir);
    const candidates: string[] = [];
    const mdIn = (d: string, onlyBriefs: boolean) => {
      try {
        for (const name of readdirSync(d)) {
          const lower = name.toLowerCase();
          if (onlyBriefs ? lower.endsWith('brief.md') : lower.endsWith('.md')) candidates.push(join(d, name));
        }
      } catch {
        // A folder that is gone has nothing to offer.
      }
    };
    mdIn(dir, false);
    try {
      for (const name of readdirSync(parent)) {
        const d = join(parent, name);
        if (d !== dir && !name.startsWith('.') && statSync(d).isDirectory()) mdIn(d, true);
        if (candidates.length > MAX_SCAN) break;
      }
    } catch {
      // No parent folder to look in.
    }
    for (const file of candidates.slice(0, MAX_SCAN)) {
      try {
        if (parseBrief(headOf(file)).id === row.id) return file;
      } catch {
        // Unreadable files are skipped.
      }
    }
    return undefined;
  }

  /**
   * Reads a row's brief, following a move and recording an edit made outside the app.
   * Either one emits, which pushes the panel and moves main's file watch to the new path.
   */
  private read(row: IndexRow): Read {
    let text: string | undefined;
    let changed = false;
    try {
      text = readFileSync(row.path, 'utf8');
    } catch {
      const moved = this.relocate(row);
      if (moved) {
        text = readFileSync(moved, 'utf8');
        row.path = moved;
        changed = true;
      }
    }
    if (text === undefined) return { row };
    const brief = parseBrief(text);
    const hash = sha(text);
    if (hash !== row.hash && !this.readOnly) {
      row.hash = hash;
      if (brief.title) row.title = brief.title;
      this.addRevision(row, 'PM');
      changed = true;
    }
    if (changed) {
      this.save();
      this.emit();
    }
    return { row, brief: { ...brief, title: brief.title || row.title } };
  }

  private initiative({ row, brief }: Read): Initiative {
    const live = this.liveSessions && new Set(this.liveSessions());
    const sessions = Object.entries(this.index.attachments)
      .filter(([sessionId, a]) => a.initiativeId === row.id && (!live || live.has(sessionId)))
      .map(([sessionId]) => sessionId);
    return {
      id: row.id,
      title: brief?.title ?? row.title,
      path: row.path,
      understanding: brief?.understanding ?? '',
      decisions: brief?.decisions ?? [],
      open: brief?.open ?? [],
      folders: brief?.folders ?? [],
      ...(brief?.outputs.length ? { outputs: brief.outputs } : {}),
      revision: row.revision,
      updatedAt: row.updatedAt,
      updatedBy: row.updatedBy,
      lastActiveAt: row.lastActiveAt,
      ...(sessions.length ? { sessions } : {}),
      ...(brief ? {} : { missing: true }),
    };
  }

  private summary(i: Initiative): InitiativeSummary {
    return { id: i.id, title: i.title, lastActiveAt: i.lastActiveAt, line: firstSentence(i.understanding) };
  }

  /** Every initiative, latest lastActiveAt first. */
  all(): Initiative[] {
    return this.index.initiatives
      .map((row) => this.initiative(this.read(row)))
      .sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
  }

  list(): InitiativeSummary[] {
    return this.all().map((i) => this.summary(i));
  }

  recent(limit = 3): InitiativeSummary[] {
    return this.list().slice(0, Math.max(0, limit));
  }

  /** The best term overlaps with `q`, ties going to the latest lastActiveAt. Initiatives with no overlap are left out. */
  find(q: string, limit = 3): InitiativeSummary[] {
    const query = terms(q);
    return this.all()
      .map((i) => ({ i, score: overlap(query, i) }))
      .filter((m) => m.score > 0)
      .sort((a, b) => b.score - a.score || b.i.lastActiveAt.localeCompare(a.i.lastActiveAt))
      .slice(0, limit)
      .map(({ i, score }) => ({ ...this.summary(i), score }));
  }

  get(id: string): Initiative {
    return this.initiative(this.read(this.row(id)));
  }

  /** Newest first. */
  history(id: string): InitiativeRevision[] {
    const row = this.row(id);
    this.read(row);
    return [...row.revisions].reverse();
  }

  /** Each brief file by initiative id, for watching. */
  files(): Map<string, string> {
    return new Map(this.index.initiatives.map((r) => [r.id, r.path]));
  }

  /** Reads one brief, which records an edit made outside the app. */
  refresh(id: string): void {
    const row = this.index.initiatives.find((r) => r.id === id);
    if (row) this.read(row);
  }

  create(req: InitiativeCreateRequest): Initiative {
    this.writable();
    const title = req.title.replace(/\s+/g, ' ').trim();
    if (!title) throw badRequest('title is required');
    const folder = expandHome(req.folder.trim(), this.home);
    if (!isAbsolute(folder)) throw badRequest('folder must be an absolute path');
    const path = join(folder, briefFileName(title));
    if (existsSync(path)) throw new BoardError('conflict', `${path} already exists`);
    let id = randomBytes(6).toString('hex');
    while (this.index.initiatives.some((r) => r.id === id)) id = randomBytes(6).toString('hex');
    const text = newBrief({
      id,
      title,
      understanding: req.understanding ?? '',
      decisions: req.decisions ?? [],
      open: req.open ?? [],
      folders: req.folders ?? [{ path: shortPath(folder, this.home), role: 'working' }],
      working: req.working,
    });
    mkdirSync(folder, { recursive: true });
    writeAtomic(path, text);
    const at = this.stamp();
    const updatedBy = req.updatedBy ?? 'PM';
    const row: IndexRow = {
      id,
      title,
      path,
      createdAt: at,
      lastActiveAt: at,
      revision: 1,
      updatedAt: at,
      updatedBy,
      hash: sha(text),
      revisions: [{ revision: 1, updatedAt: at, updatedBy, changed: ['created'] }],
    };
    this.index.initiatives.push(row);
    this.save();
    this.emit();
    return this.get(id);
  }

  /** Writes the fields given, against `revision`. A stale revision is a conflict. */
  update(id: string, req: InitiativeUpdateRequest): Initiative {
    this.writable();
    const read = this.read(this.row(id));
    const { row, brief } = read;
    if (!brief) throw notFound(`the brief for ${row.title} is not at ${row.path}`);
    if (req.revision !== row.revision) {
      throw new BoardError('conflict', `revision ${req.revision} is stale: ${row.title} is at revision ${row.revision}. Read it again and redo the change.`);
    }
    const next: BriefFields = {
      understanding: req.understanding ?? brief.understanding,
      decisions: req.decisions ?? brief.decisions,
      open: req.open ?? brief.open,
      folders: req.folders ?? brief.folders,
      outputs: brief.outputs,
    };
    if (!this.write(row, brief, next, req.updatedBy)) return this.initiative(read);
    return this.get(id);
  }

  /**
   * Adds the session's declared, ready outputs to its initiative's Outputs rows.
   * True when the brief changed. Rows are never removed.
   */
  recordOutputs(sessionId: string, cwd: string, records: readonly OutputRecord[]): boolean {
    this.writable();
    const id = this.attached(sessionId);
    const links = readyOutputLinks(cwd, records);
    if (!id || links.length === 0) return false;
    const { row, brief } = this.read(this.row(id));
    if (!brief) return false;
    return this.write(row, brief, { ...brief, outputs: mergeOutputRows(brief.outputs, links) }, `Agent Brief · ${sessionId}`);
  }

  /** Writes the changed fields as a new revision. False when nothing changed. */
  private write(row: IndexRow, brief: ParsedBrief, next: BriefFields, updatedBy: string): boolean {
    const changed = changedFields(brief, next);
    if (changed.length === 0) return false;
    const text = formatBrief(brief, next);
    writeAtomic(row.path, text);
    row.hash = sha(text);
    row.lastActiveAt = this.stamp();
    this.addRevision(row, updatedBy, changed);
    this.save();
    this.emit();
    return true;
  }

  attach(sessionId: string, initiativeId: string): InitiativeSnapshot {
    this.writable();
    const row = this.row(initiativeId);
    const prev = this.index.attachments[sessionId];
    const at = this.stamp();
    this.index.attachments[sessionId] = { initiativeId, attachmentRevision: (prev?.attachmentRevision ?? 0) + 1, at };
    row.lastActiveAt = at;
    this.save();
    this.emit();
    return this.snapshot(sessionId)!;
  }

  /** True when the session had an initiative. */
  detach(sessionId: string): boolean {
    this.writable();
    const att = this.index.attachments[sessionId];
    if (!att?.initiativeId) return false;
    delete att.initiativeId;
    this.save();
    this.emit();
    return true;
  }

  /** The id of the initiative attached to the session, if any. */
  attached(sessionId: string): string | undefined {
    const id = this.index.attachments[sessionId]?.initiativeId;
    return id && this.index.initiatives.some((r) => r.id === id) ? id : undefined;
  }

  /** What the mod injects into the session, Understanding capped. Undefined when nothing is attached. */
  snapshot(sessionId: string): InitiativeSnapshot | undefined {
    const id = this.attached(sessionId);
    if (!id) return undefined;
    const read = this.read(this.row(id));
    const i = this.initiative(read);
    const outputs = read.brief?.outputs ?? [];
    const cap = INITIATIVE_UNDERSTANDING_CAP;
    const understanding = i.understanding.length > cap ? `${i.understanding.slice(0, cap - 1).trimEnd()}…` : i.understanding;
    return {
      id: i.id,
      title: i.title,
      revision: i.revision,
      attachmentRevision: this.index.attachments[sessionId]!.attachmentRevision,
      understanding,
      decisions: i.decisions,
      open: i.open,
      folders: i.folders,
      ...(outputs.length ? { outputs } : {}),
    };
  }

  private writable(): void {
    if (this.readOnly) throw new BoardError('unavailable', 'this initiative store is read-only');
  }
}
