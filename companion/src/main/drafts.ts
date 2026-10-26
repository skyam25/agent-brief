/** Drafts on disk: one `<dataDir>/drafts/<id>.json` per draft. */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { badRequest } from '../board/errors';
import { ATTACHMENT_ID } from '../shared/attachments';
import { newDraftId, sortDrafts } from '../shared/drafts';
import type { Draft, DraftImage } from '../shared/ipc';
import type { DeliveryInput } from '../server/contract';
import { cleanAnnotations } from '../shared/annotations';
import { cleanReview } from '../shared/review';
import { isOutlinePath } from '../shared/outline';

const ID = /^[\w-]{1,64}$/;
/** The longest draft body, in characters. */
export const MAX_DRAFT_BODY = 200_000;
/** The longest draft title, in characters. */
const MAX_TITLE = 200;
const MAX_ATTACHMENTS = 40;
const MAX_PICTURE = 6 * 1024 * 1024;
const PICTURE = /^data:image\/(png|jpeg|webp|gif);base64,/;

/** Checks a draft's pictures. Undefined when it has none. */
function cleanAttachments(raw: unknown): Record<string, string> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw badRequest('draft attachments must map picture ids to data URLs');
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > MAX_ATTACHMENTS) throw badRequest(`a draft holds at most ${MAX_ATTACHMENTS} pictures`);
  for (const [id, data] of entries) {
    if (!ATTACHMENT_ID.test(id)) throw badRequest('picture ids are 6 to 24 lowercase letters and digits');
    if (typeof data !== 'string' || !PICTURE.test(data)) throw badRequest('a picture must be a png, jpeg, webp or gif data URL');
    if (data.length >= MAX_PICTURE) throw badRequest('each picture must be under 6 MB');
  }
  return entries.length ? Object.fromEntries(entries as [string, string][]) : undefined;
}

/** Checks a draft from the renderer and keeps only the fields a draft has. */
export function cleanDraft(raw: unknown): Draft {
  const d = raw as Partial<Draft> | null;
  if (!d || typeof d !== 'object') throw badRequest('draft must be an object');
  if (typeof d.id !== 'string' || !ID.test(d.id)) throw badRequest('draft id may use letters, digits, dashes and underscores');
  if (typeof d.body !== 'string' || d.body.length > MAX_DRAFT_BODY) throw badRequest('draft body must be text under 200,000 characters');
  if (d.status !== 'note' && d.status !== 'ready') throw badRequest('draft status is note or ready');
  if (d.board !== undefined && typeof d.board !== 'string') throw badRequest('draft board must be a board name');
  if (d.sessionId !== undefined && typeof d.sessionId !== 'string') throw badRequest('draft sessionId must be a session id');
  const attachments = cleanAttachments(d.attachments);
  const source = d.source && typeof d.source === 'object' && typeof d.source.path === 'string' && d.source.path.trim()
    ? { path: d.source.path, ...(typeof d.source.sessionId === 'string' && d.source.sessionId ? { sessionId: d.source.sessionId } : {}), ...(typeof d.source.text === 'string' && d.source.text.length <= MAX_DRAFT_BODY ? { text: d.source.text } : {}) }
    : undefined;
  const review = d.review === undefined ? undefined : cleanReview(d.review);
  const outlinePath = typeof d.outline?.path === 'string' ? d.outline.path.trim() : '';
  const outline = isOutlinePath(outlinePath) && !isAbsolute(outlinePath) && !outlinePath.split(/[\\/]/).includes('..') ? { path: outlinePath } : undefined;
  const annotations = d.annotations === undefined ? undefined : cleanAnnotations(d.annotations);
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const title = typeof d.title === 'string' ? d.title.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE) : '';
  return {
    id: d.id,
    body: d.body,
    status: d.status,
    ...(title ? { title } : {}),
    ...(d.board ? { board: d.board } : {}),
    ...(d.sessionId ? { sessionId: d.sessionId } : {}),
    ...(attachments ? { attachments } : {}),
    ...(source ? { source } : {}),
    ...(review ? { review } : {}),
    ...(annotations ? { annotations } : {}),
    ...(outline ? { outline } : {}),
    rank: num(d.rank),
    createdAt: num(d.createdAt),
    updatedAt: num(d.updatedAt),
  };
}

const PICTURE_DATA = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]*={0,2})$/;
const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

/** Decodes a Send's pictures into bundle files named `<id>.<ext>`. Skips a malformed one with a warning. */
export function deliveryImages(images: readonly DraftImage[] | undefined): NonNullable<DeliveryInput['images']> {
  const out: NonNullable<DeliveryInput['images']> = [];
  const seen = new Set<string>();
  for (const img of images ?? []) {
    const m = typeof img?.data === 'string' ? PICTURE_DATA.exec(img.data) : null;
    if (!m || typeof img.id !== 'string' || !ATTACHMENT_ID.test(img.id)) {
      console.warn(`[companion] skipped picture ${String(img?.id)}: not a png, jpeg, webp or gif data URL`);
      continue;
    }
    if (seen.has(img.id)) continue;
    seen.add(img.id);
    out.push({ name: `${img.id}.${EXT[m[1]]}`, data: Buffer.from(m[2], 'base64'), mime: m[1] });
  }
  return out;
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

  /** Saves the panel's copy, unless the stored draft changed after it, as `replaceNote` does. Answers what is stored. */
  saveFromPanel(raw: unknown): Draft {
    const draft = cleanDraft(raw);
    const stored = this.get(draft.id);
    if (stored && stored.updatedAt > draft.updatedAt) return stored;
    return this.save(draft);
  }

  /** Saves a new note from outside the panel, filed under `sessionId` when one is given. */
  addNote(note: { text: string; title?: string; sessionId?: string }, now = Date.now()): Draft {
    return this.save({
      id: newDraftId(now),
      body: note.text,
      status: 'note',
      ...(note.title ? { title: note.title } : {}),
      ...(note.sessionId ? { sessionId: note.sessionId } : {}),
      rank: 0,
      createdAt: now,
      updatedAt: now,
    });
  }

  /** Replaces a saved note's text, and its title when given. Undefined when there is no such note. */
  replaceNote(id: string, note: { text: string; title?: string }, now = Date.now()): Draft | undefined {
    const draft = this.get(id);
    if (!draft) return undefined;
    return this.save({ ...draft, body: note.text, ...(note.title ? { title: note.title } : {}), updatedAt: now });
  }

  remove(id: string): void {
    rmSync(this.path(id), { force: true });
  }

  /** Unlinks every draft from a deleted board. */
  forgetBoard(board: string): void {
    for (const d of this.list()) {
      if (d.board !== board) continue;
      const { board: _gone, ...rest } = d;
      this.save(rest);
    }
  }

  /** Points every draft linked to board `from` at `to`, after a rename. */
  renameBoard(from: string, to: string): void {
    for (const d of this.list()) if (d.board === from) this.save({ ...d, board: to });
  }
}
