/**
 * Opens and saves feedback items' workspace boards. Board work goes through the
 * board backend, so a workspace open in the panel draws and exports live.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { FeedbackDocument, FeedbackItem, FeedbackUpdateResult, FeedbackWorkspace } from '../protocol';
import type { BoardBackend } from '../server/contract';
import { BoardError, badRequest, notFound } from '../board/errors';
import { feedbackAssets } from '../shared/feedback';
import {
  boundTo,
  isWorkspaceBoard,
  latestWorkspace,
  seedRequest,
  workspaceBinding,
  workspaceBoardName,
  workspaceLine,
  workspaceRound,
  type WorkspaceSnapshot,
} from '../shared/feedback-workspace';
import type { FeedbackStore } from './feedback';
import type { BoardStore } from './store';

/** Long edge of the saved PNG. */
const SAVE_MAX_EDGE = 2400;
const MAX_SNAPSHOT_CHARS = 12 * 1024 * 1024;
/** Variants tried after `fb-<stem>-<n>` before giving up. */
const MAX_ATTEMPTS = 50;

export interface WorkspaceDeps {
  feedback: Pick<FeedbackStore, 'read' | 'update'>;
  store: Pick<BoardStore, 'exists' | 'create' | 'load' | 'saveNotes'>;
  boards: Pick<BoardBackend, 'read' | 'draw' | 'png'>;
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

function writeAtomic(file: string, bytes: Uint8Array): void {
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, bytes, { flag: 'wx' });
    renameSync(tmp, file);
  } finally {
    if (existsSync(tmp)) unlinkSync(tmp);
  }
}

export class FeedbackWorkspaces {
  constructor(private readonly deps: WorkspaceDeps) {}

  private find(root: string, output: unknown, n: unknown): Found {
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) throw badRequest('Expected an item number');
    const doc = this.deps.feedback.read(root, output);
    const item = doc.items.find((i) => i.n === n);
    if (!item) throw notFound(`${doc.path} has no item #${n}`);
    return { doc, item, outputFile: join(realpathSync(root), doc.output) };
  }

  /** The board the item's last Workspace line names, else the first `fb-<stem>-<n>` variant bound to it or free. */
  private boardOf({ doc, item, outputFile }: Found, create: boolean): { board: string; created: boolean } {
    const { store } = this.deps;
    const saved = latestWorkspace(item)?.board;
    if (saved && isWorkspaceBoard(saved) && store.exists(saved)) return { board: saved, created: false };
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

  /** Makes the item's board when missing and gives it a frame for the item's newest round. */
  async open(root: string, output: unknown, n: unknown, rawSnapshot?: unknown): Promise<FeedbackWorkspace> {
    const found = this.find(root, output, n);
    const { board, created } = this.boardOf(found, true);
    const scene = await this.deps.boards.read(board);
    const req = seedRequest(found.item, scene, snapshotOf(rawSnapshot));
    if (req) await this.deps.boards.draw(board, req);
    return { board, round: workspaceRound(found.item), created, framed: !!req };
  }

  /** Exports the board beside the output and appends a Workspace line as `by`. Sends nothing. */
  async save(root: string, output: unknown, n: unknown, by: 'You' | 'Claude'): Promise<FeedbackUpdateResult> {
    const found = this.find(root, output, n);
    const { board } = this.boardOf(found, false);
    const png = await this.deps.boards.png(board, { maxEdge: SAVE_MAX_EDGE });
    const dir = join(dirname(found.outputFile), feedbackAssets(basename(found.outputFile)));
    if (existsSync(dir) && (lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory())) throw badRequest(`${basename(dir)} must be a folder`);
    mkdirSync(dir, { recursive: true });
    const name = `${found.item.n}-workspace.png`;
    writeAtomic(join(dir, name), png);
    const text = workspaceLine(board, `${feedbackAssets(basename(found.doc.output))}/${name}`);
    const ops = [{ op: 'append' as const, item: found.item.n, key: 'Workspace', text }];
    // Ops only add, so a write that lost a race reads again and retries once.
    for (let attempt = 0; ; attempt++) {
      const { version } = attempt === 0 ? found.doc : this.deps.feedback.read(root, output);
      try {
        return this.deps.feedback.update(root, output, { version, ops }, by);
      } catch (err) {
        if ((err as { code?: string }).code !== 'conflict' || attempt > 0) throw err;
      }
    }
  }
}
