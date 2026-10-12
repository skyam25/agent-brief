/** Holds the drafts Write mode shows, with the open one and debounced saves. */

import { newDraftId, referencedImages, sortDrafts } from '../shared/drafts';
import type { CompanionApi, Draft, DraftSource } from '../shared/ipc';

export const DRAFT_SAVE_MS = 400;
/** How long a failed save waits before it tries again. */
export const DRAFT_RETRY_MS = 2000;
/** How many pictures taken out of drafts stay at hand for undo or a paste. */
const LOOSE_IMAGES = 40;

type DraftHost = Pick<CompanionApi, 'listDrafts' | 'saveDraft' | 'deleteDraft'>;

/**
 * A draft with nothing in it stays in memory, so leaving it leaves nothing behind.
 * Its attachments need no check, because `edit` keeps only the ones the body references.
 */
const isEmpty = (d: Draft) => !d.body.trim() && !d.board;

/**
 * Whether a draft belongs on a tab: a session tab holds the notes filed under it,
 * and the Notes tab (`sessionId` undefined) holds the rest, including notes whose
 * session has no tab any more.
 */
export function onTab(d: Draft, sessionId: string | undefined, tabs: readonly string[]): boolean {
  if (sessionId) return d.sessionId === sessionId;
  return !d.sessionId || !tabs.includes(d.sessionId);
}

/** What a Send took from a draft. */
export interface SentRevision {
  body: string;
  board?: string;
}

export class DraftBook {
  /** Sorted as the list shows them. Replaced on every change, for React. */
  drafts: Draft[] = [];
  selectedId?: string;
  /** Bumps on every change, as the snapshot React compares. */
  version = 0;
  /** Why the last save failed, until one succeeds. */
  saveError?: string;
  /** Drafts changed here and not yet on disk. */
  private readonly dirty = new Set<string>();
  /** Drafts whose save is on its way, which a reload must not overwrite either. */
  private readonly saving = new Set<string>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly listeners = new Set<() => void>();
  /** Pictures an edit took out of a draft, by id. An undo or a paste that brings the reference back finds them here. */
  private readonly loose = new Map<string, string>();

  constructor(
    private readonly host: DraftHost,
    private readonly now: () => number = Date.now,
  ) {}

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    this.version++;
    for (const fn of this.listeners) fn();
  }

  /** Reads drafts from disk. Edits not saved yet win over what disk has. */
  async load(): Promise<void> {
    const saved = await this.host.listDrafts();
    const onDisk = new Set(saved.map((d) => d.id));
    const local = this.drafts.filter((d) => this.dirty.has(d.id) || this.saving.has(d.id) || (isEmpty(d) && !onDisk.has(d.id)));
    const keep = new Set(local.map((d) => d.id));
    this.drafts = sortDrafts([...saved.filter((d) => !keep.has(d.id)), ...local]);
    if (this.selectedId && !this.get(this.selectedId)) this.selectedId = undefined;
    this.emit();
  }

  get(id: string | undefined): Draft | undefined {
    return id === undefined ? undefined : this.drafts.find((d) => d.id === id);
  }

  get selected(): Draft | undefined {
    return this.get(this.selectedId);
  }

  get ready(): Draft[] {
    return this.drafts.filter((d) => d.status === 'ready');
  }

  /** The first draft with something in it on a tab. See `onTab`. */
  firstOnTab(sessionId: string | undefined, tabs: readonly string[]): Draft | undefined {
    return this.drafts.find((d) => !isEmpty(d) && onTab(d, sessionId, tabs));
  }

  /** The draft that goes out with `board`'s sketch. */
  linkedTo(board: string): Draft | undefined {
    return this.drafts.find((d) => d.board === board);
  }

  /** Opens a draft. The one you leave goes away if it is empty. */
  select(id: string | undefined): void {
    const leaving = this.selected;
    this.selectedId = id;
    if (leaving && leaving.id !== id && isEmpty(leaving)) {
      this.drop(leaving.id);
      void this.host.deleteDraft(leaving.id);
    }
    this.emit();
  }

  /**
   * Starts a note filed under `sessionId`, or unfiled, and opens it. Reuses the
   * open note when it is still empty and filed the same way, unless main asked
   * for a note with another `id`, which it keeps for a session. A `source` marks
   * the note as a copy of that output file.
   */
  create(body = '', id?: string, sessionId?: string, source?: DraftSource): Draft {
    const open = this.selected;
    if (open && isEmpty(open) && !body && !source && open.sessionId === sessionId && (id === undefined || open.id === id)) return open;
    const t = this.now();
    const draft: Draft = { id: id ?? newDraftId(t), body, status: 'note', rank: 0, createdAt: t, updatedAt: t };
    if (sessionId) draft.sessionId = sessionId;
    if (source) draft.source = source;
    this.drafts = sortDrafts([draft, ...this.drafts]);
    this.select(draft.id);
    if (body) this.save(draft.id);
    return draft;
  }

  /** Sets the body and keeps exactly the attachments it references. */
  edit(id: string, body: string): void {
    const draft = this.get(id);
    if (!draft) return;
    const had = draft.attachments ?? {};
    const attachments: Record<string, string> = {};
    for (const imageId of referencedImages(body)) {
      const data = had[imageId] ?? this.loose.get(imageId) ?? this.drafts.find((d) => d.attachments?.[imageId])?.attachments?.[imageId];
      if (data) attachments[imageId] = data;
    }
    for (const [imageId, data] of Object.entries(had)) if (!attachments[imageId]) this.keepLoose(imageId, data);
    this.patch(id, { body, attachments });
  }

  /** Keeps a pasted picture on the draft under `imageId`. The body references it as `att:<imageId>`. */
  attach(id: string, imageId: string, dataUrl: string): void {
    const draft = this.get(id);
    if (!draft) return;
    this.patch(id, { attachments: { ...draft.attachments, [imageId]: dataUrl } });
  }

  private keepLoose(imageId: string, data: string): void {
    this.loose.delete(imageId);
    this.loose.set(imageId, data);
    if (this.loose.size > LOOSE_IMAGES) this.loose.delete(this.loose.keys().next().value!);
  }

  /** Ready joins the end of the queue; back to a note leaves it. */
  setReady(id: string, ready: boolean): void {
    const rank = ready ? Math.max(0, ...this.ready.map((d) => d.rank)) + 1 : 0;
    this.patch(id, { status: ready ? 'ready' : 'note', rank });
  }

  /** Moves a Ready draft to `index` in the queue and renumbers the queue. */
  move(id: string, index: number): void {
    const queue = this.ready.filter((d) => d.id !== id);
    const moving = this.get(id);
    if (!moving || moving.status !== 'ready') return;
    queue.splice(Math.max(0, Math.min(index, queue.length)), 0, moving);
    queue.forEach((d, i) => {
      if (d.rank !== i + 1) this.patch(d.id, { rank: i + 1 }, false);
    });
    this.drafts = sortDrafts(this.drafts);
    this.emit();
  }

  /** Links a draft to a board, or unlinks it. A board carries one draft, so others let go. */
  link(id: string, board: string | undefined): void {
    if (board) for (const d of this.drafts) if (d.board === board && d.id !== id) this.patch(d.id, { board: undefined }, false);
    this.patch(id, { board });
  }

  /** Files a draft under a session, or unfiles it. */
  file(id: string, sessionId: string | undefined): void {
    this.patch(id, { sessionId });
  }

  /** Deletes a draft for good. */
  remove(id: string): void {
    this.drop(id);
    void this.host.deleteDraft(id);
    this.emit();
  }

  /**
   * Main deleted a draft after a Send used it up. Text typed while the Send was
   * on its way did not go out, so the draft stays and is saved again.
   */
  consume(id: string, sent: SentRevision): void {
    const draft = this.get(id);
    if (draft && (draft.body !== sent.body || draft.board !== sent.board)) {
      this.save(id);
      this.emit();
      return;
    }
    this.drop(id);
    this.emit();
  }

  /** Board renames move links in main; this keeps the open list in step. */
  /** Unlinks drafts from a deleted board. Main has already saved the change. */
  forgetBoard(board: string): void {
    this.drafts = this.drafts.map((d) => {
      if (d.board !== board) return d;
      const { board: _gone, ...rest } = d;
      return rest;
    });
    this.emit();
  }

  renameBoard(from: string, to: string): void {
    this.drafts = this.drafts.map((d) => (d.board === from ? { ...d, board: to } : d));
    this.emit();
  }

  /** Writes every pending save now, trying a failed one once more. Ones that still fail stay pending. */
  async flush(): Promise<void> {
    for (let attempt = 0; attempt < 2 && this.dirty.size > 0; attempt++) {
      for (const timer of this.timers.values()) clearTimeout(timer);
      this.timers.clear();
      await Promise.all([...this.dirty].map((id) => this.write(id)));
    }
  }

  private patch(id: string, change: Partial<Draft>, emit = true): void {
    const at = this.drafts.findIndex((d) => d.id === id);
    if (at === -1) return;
    const next = { ...this.drafts[at], ...change, updatedAt: this.now() };
    if (!next.board) delete next.board;
    if (!next.sessionId) delete next.sessionId;
    if (!next.attachments || Object.keys(next.attachments).length === 0) delete next.attachments;
    const list = [...this.drafts];
    list[at] = next;
    this.drafts = sortDrafts(list);
    this.save(id);
    if (emit) this.emit();
  }

  private save(id: string, delay = DRAFT_SAVE_MS): void {
    this.dirty.add(id);
    clearTimeout(this.timers.get(id));
    this.timers.set(
      id,
      setTimeout(() => {
        this.timers.delete(id);
        void this.write(id);
      }, delay),
    );
  }

  /** Saves a draft with something in it, and deletes one emptied after a save. A failure retries. */
  private async write(id: string): Promise<void> {
    const draft = this.get(id);
    this.dirty.delete(id);
    if (!draft) return;
    this.saving.add(id);
    try {
      if (isEmpty(draft)) await this.host.deleteDraft(id);
      else await this.host.saveDraft(draft);
      if (this.saveError && this.dirty.size === 0) {
        this.saveError = undefined;
        this.emit();
      }
    } catch (err) {
      if (!this.get(id)) return;
      this.saveError = (err as Error).message;
      if (!this.dirty.has(id)) this.save(id, DRAFT_RETRY_MS);
      this.emit();
    } finally {
      this.saving.delete(id);
    }
  }

  private drop(id: string): void {
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    this.dirty.delete(id);
    this.drafts = this.drafts.filter((d) => d.id !== id);
    if (this.selectedId === id) this.selectedId = undefined;
  }
}
