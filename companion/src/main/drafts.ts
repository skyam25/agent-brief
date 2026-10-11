/** Drafts on disk: one `<dataDir>/drafts/<id>.json` per draft. */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { badRequest } from '../board/errors';
import { sortDrafts } from '../shared/drafts';
import type { Draft } from '../shared/ipc';

const ID = /^[\w-]{1,64}$/;
const MAX_BODY = 200_000;

/** Checks a draft from the renderer and keeps only the fields a draft has. */
export function cleanDraft(raw: unknown): Draft {
  const d = raw as Partial<Draft> | null;
  if (!d || typeof d !== 'object') throw badRequest('draft must be an object');
  if (typeof d.id !== 'string' || !ID.test(d.id)) throw badRequest('draft id may use letters, digits, dashes and underscores');
  if (typeof d.body !== 'string' || d.body.length > MAX_BODY) throw badRequest('draft body must be text under 200,000 characters');
  if (d.status !== 'note' && d.status !== 'ready') throw badRequest('draft status is note or ready');
  if (d.board !== undefined && typeof d.board !== 'string') throw badRequest('draft board must be a board name');
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    id: d.id,
    body: d.body,
    status: d.status,
    ...(d.board ? { board: d.board } : {}),
    rank: num(d.rank),
    createdAt: num(d.createdAt),
    updatedAt: num(d.updatedAt),
  };
}

export class DraftStore {
  readonly dir: string;

  constructor(dataDir: string) {
    this.dir = join(dataDir, 'drafts');
    mkdirSync(this.dir, { recursive: true });
  }

  private path(id: string): string {
    if (!ID.test(id)) throw badRequest(`bad draft id ${JSON.stringify(id)}`);
    return join(this.dir, `${id}.json`);
  }

  list(): Draft[] {
    const drafts: Draft[] = [];
    for (const file of readdirSync(this.dir)) {
      if (!file.endsWith('.json')) continue;
      try {
        drafts.push(cleanDraft(JSON.parse(readFileSync(join(this.dir, file), 'utf8'))));
      } catch (err) {
        console.warn(`[companion] skipped draft ${file}: ${(err as Error).message}`);
      }
    }
    return sortDrafts(drafts);
  }

  get(id: string): Draft | undefined {
    const path = this.path(id);
    return existsSync(path) ? cleanDraft(JSON.parse(readFileSync(path, 'utf8'))) : undefined;
  }

  save(raw: unknown): Draft {
    const draft = cleanDraft(raw);
    const path = this.path(draft.id);
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(draft, null, 2));
    renameSync(tmp, path);
    return draft;
  }

  remove(id: string): void {
    rmSync(this.path(id), { force: true });
  }

  /** Points every draft linked to board `from` at `to`, after a rename. */
  renameBoard(from: string, to: string): void {
    for (const d of this.list()) if (d.board === from) this.save({ ...d, board: to });
  }
}
