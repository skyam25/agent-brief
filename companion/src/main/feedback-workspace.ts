/**
 * Opens and saves feedback items' workspace boards. Board work goes through the
 * board backend, so a workspace open in the panel draws and exports live.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, linkSync, lstatSync, mkdirSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { FeedbackDocument, FeedbackItem, FeedbackUpdateResult, FeedbackWorkspace } from '../protocol';
import type { BoardBackend } from '../server/contract';
import { BoardError, badRequest, notFound } from '../board/errors';
import { cleanBoardComments } from '../shared/board-comments';
import { feedbackAssets } from '../shared/feedback';
import {
  bindingOf,
  boundTo,
  commentNotes,
  itemNote,
  itemNoteLine,
  itemNoteMarker,
  latestWorkspace,
  seedRequest,
  workspaceBinding,
  workspaceBoardName,
  workspaceLine,
  workspacePng,
  workspaceRound,
  type WorkspaceSnapshot,
} from '../shared/feedback-workspace';
import type { DraftStore } from './drafts';
import type { FeedbackStore } from './feedback';
import type { BoardStore } from './store';

/** Long edge of the saved PNG. */
const SAVE_MAX_EDGE = 2400;
const MAX_SNAPSHOT_CHARS = 12 * 1024 * 1024;
/** Variants tried after `fb-<stem>-<n>`, and revision names tried per save, before giving up. */
const MAX_ATTEMPTS = 50;

export interface WorkspaceDeps {
  feedback: Pick<FeedbackStore, 'read' | 'update'>;
  store: Pick<BoardStore, 'exists' | 'create' | 'load' | 'saveNotes'>;
  boards: Pick<BoardBackend, 'read' | 'draw' | 'png'>;
  /** Write notes, for Add to note. `show` opens one in the panel. */
  notes?: { drafts: Pick<DraftStore, 'list' | 'addNote'>; show: (sessionId: string, id: string) => void };
}

interface Found {
  doc: FeedbackDocument;
  item: FeedbackItem;
  /** The output's real path, which the board's binding names. */
  outputFile: string;
}

/** A snapshot the renderer sent, or nothing when it is not a picture. */
function snapshotOf(raw: unknown): WorkspaceSnapshot | undefined {
  const s = raw as Partial<WorkspaceSnapshot> | undefined;
  if (!s || typeof s.data !== 'string' || s.data.length > MAX_SNAPSHOT_CHARS) return undefined;
  if (!/^data:image\/(png|jpeg|webp);base64,/.test(s.data)) return undefined;
  const ok = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 1 && v <= 10_000;
  return ok(s.width) && ok(s.height) ? { data: s.data, width: s.width, height: s.height } : undefined;
}

/**
 * The folder `rel` under the real project root, made when missing. Every folder on
 * the way must be a real folder, so a link swapped in cannot point the write elsewhere.
 * TODO: use the shared resolver in feedback-paths.ts.
 */
function assetDir(realRoot: string, rel: string): string {
  let dir = realRoot;
  for (const part of rel.split('/')) {
    dir = join(dir, part);
    try {
      mkdirSync(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    const st = lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) throw badRequest(`${rel} must be a folder inside the project`);
  }
  return dir;
}

/** Writes the PNG under the item's next free revision name, never over a file that is there. */
function writeRevision(dir: string, item: FeedbackItem, png: Uint8Array): string {
  const saves = item.events.filter((e) => e.key === 'Workspace' && e.verb === 'saved').length;
  for (let k = saves + 1; k <= saves + MAX_ATTEMPTS; k++) {
    const name = workspacePng(item.n, k);
    const tmp = join(dir, `.${name}.${randomUUID()}.tmp`);
    try {
      writeFileSync(tmp, png, { flag: 'wx' });
      linkSync(tmp, join(dir, name));
      return name;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    } finally {
      if (existsSync(tmp)) unlinkSync(tmp);
    }
  }
  throw new BoardError('conflict', `every workspace picture name for #${item.n} is taken`);
}

export class FeedbackWorkspaces {
  /** Opens and saves run one at a time, so no two read, check and draw the same board at once. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: WorkspaceDeps) {}

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private find(root: string, output: unknown, n: unknown): Found {
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) throw badRequest('Expected an item number');
    const doc = this.deps.feedback.read(root, output);
    const item = doc.items.find((i) => i.n === n);
    if (!item) throw notFound(`${doc.path} has no item #${n}`);
    return { doc, item, outputFile: join(realpathSync(root), doc.output) };
  }

  /**
   * The board the item's last Workspace line names, when its binding is this item.
   * A board bound to the same item of an output that no longer exists moved with its
   * project, so it is rebound here. A board bound to an output that exists belongs to
   * that output, as after a copy, and is never adopted.
   */
  private savedBoard({ item, outputFile }: Found): string | undefined {
    const { store } = this.deps;
    const name = latestWorkspace(item)?.board;
    if (!name || !store.exists(name)) return undefined;
    const notes = store.load(name).notes;
    if (boundTo(notes, outputFile, item.n)) return name;
    const bound = bindingOf(notes);
    if (!bound || bound.n !== item.n || existsSync(bound.outputFile)) return undefined;
    store.saveNotes(name, [workspaceBinding(outputFile, item.n), ...notes.split('\n').slice(1)].join('\n'));
    return name;
  }

  /** The saved board when it is the item's, else the first `fb-<stem>-<n>` variant bound to it or free. */
  private boardOf(found: Found, create: boolean): { board: string; created: boolean } {
    const { store } = this.deps;
    const { doc, item, outputFile } = found;
    const saved = this.savedBoard(found);
    if (saved) return { board: saved, created: false };
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const name = workspaceBoardName(doc.output, item.n, attempt);
      if (store.exists(name)) {
        if (boundTo(store.load(name).notes, outputFile, item.n)) return { board: name, created: false };
        continue;
      }
      if (!create) break;
      store.create(name);
      store.saveNotes(name, `${workspaceBinding(outputFile, item.n)}\n`);
      return { board: name, created: true };
    }
    if (!create) throw notFound(`#${item.n} has no workspace yet. Open it first.`);
    throw new BoardError('conflict', `every workspace name for #${item.n} is taken`);
  }

  /** Makes the item's board when missing and gives it what it lacks: a frame per round, and the newest one's picture. */
  open(root: string, output: unknown, n: unknown, rawSnapshot?: unknown): Promise<FeedbackWorkspace> {
    const snapshot = snapshotOf(rawSnapshot);
    return this.serial(async () => {
      const found = this.find(root, output, n);
      const { board, created } = this.boardOf(found, true);
      const scene = await this.deps.boards.read(board);
      const req = seedRequest(found.item, scene, snapshot);
      if (req) await this.deps.boards.draw(board, req);
      return { board, round: workspaceRound(found.item), created, framed: !!req };
    });
  }

  /**
   * Exports the board beside the output as a new PNG and appends a Workspace line as `by`.
   * The user's comments become `You: note` lines before it, and their pins badges on the PNG. Sends nothing.
   */
  save(root: string, output: unknown, n: unknown, by: 'You' | 'Claude', rawComments?: unknown): Promise<FeedbackUpdateResult> {
    const comments = by === 'You' ? cleanBoardComments(rawComments) : undefined;
    const { pins, lines } = comments ? commentNotes(comments) : { pins: [], lines: [] };
    return this.serial(async () => {
      const { board } = this.boardOf(this.find(root, output, n), false);
      const png = await this.deps.boards.png(board, { maxEdge: SAVE_MAX_EDGE, ...(pins.length ? { pins } : {}) });
      // The export took a while, so the output, the item and the folders are checked again before writing.
      const found = this.find(root, output, n);
      const dir = assetDir(realpathSync(root), feedbackAssets(found.doc.output));
      const name = writeRevision(dir, found.item, png);
      const text = workspaceLine(board, `${feedbackAssets(basename(found.doc.output))}/${name}`);
      const ops = [...lines.map((line) => ({ op: 'append' as const, item: found.item.n, key: 'You', text: line })), { op: 'append' as const, item: found.item.n, key: 'Workspace', text }];
      return this.append(root, output, found.doc.version, ops, by);
    });
  }

  /** Opens the session's Write note linked to the item. A new one gets a `You: note` line naming it. */
  note(root: string, output: unknown, n: unknown, sessionId: string): { draftId: string; created: boolean } {
    if (!this.deps.notes) throw new BoardError('unavailable', 'this app does not take notes');
    const { drafts, show } = this.deps.notes;
    const { doc, item } = this.find(root, output, n);
    const marker = itemNoteMarker(doc.output, item.n);
    const kept = drafts.list().find((d) => d.sessionId === sessionId && d.body.includes(marker));
    if (kept) {
      show(sessionId, kept.id);
      return { draftId: kept.id, created: false };
    }
    const { title, text } = itemNote(doc.output, item);
    const draft = drafts.addNote({ text, title, sessionId });
    this.append(root, output, doc.version, [{ op: 'append', item: item.n, key: 'You', text: itemNoteLine(title) }], 'You');
    show(sessionId, draft.id);
    return { draftId: draft.id, created: true };
  }

  /** Ops only add, so a write that lost a race reads again and retries once. */
  private append(root: string, output: unknown, version: string, ops: { op: 'append'; item: number; key: string; text: string }[], by: 'You' | 'Claude'): FeedbackUpdateResult {
    for (let attempt = 0; ; attempt++) {
      try {
        return this.deps.feedback.update(root, output, { version: attempt === 0 ? version : this.deps.feedback.read(root, output).version, ops }, by);
      } catch (err) {
        if ((err as { code?: string }).code !== 'conflict' || attempt > 0) throw err;
      }
    }
  }
}
