import type { BehaviorDocument } from '../protocol';
import type { NoteAnnotations, NoteComment } from '../shared/annotations';
import { hasReviewContent } from '../shared/review';
/** Holds the drafts Write mode shows, with the open one and debounced saves. */

import { draftKind, inWrite, keptImages, newDraftId, sortDrafts } from '../shared/drafts';
import type { CompanionApi, Draft, DraftSource, ReviewTab } from '../shared/ipc';
import { SaveQueue } from './save-queue';
import { MAX_EDITS, type DraftReview, type ReviewComment } from '../shared/review';

export const DRAFT_SAVE_MS = 400;
/** How long a failed save waits before it tries again. */
export const DRAFT_RETRY_MS = 2000;
/** How many pictures taken out of drafts stay at hand for undo or a paste. */
const LOOSE_IMAGES = 40;

type DraftHost = Pick<CompanionApi, 'listDrafts' | 'saveDraft' | 'deleteDraft' | 'readSource' | 'watchOutput' | 'unwatchOutput' | 'onOutputChanged'>;

/** How a note opened from a file stands against the file: matching it, just updated to it, or edited while the file changed. */
export type SourceSync = 'same' | 'updated' | 'changed';

const sameText = (a: string, b: string) => a.trimEnd() === b.trimEnd();

/**
 * A draft with nothing in it stays in memory, so leaving it leaves nothing behind.
 * Its attachments need no check, because `edit` keeps only the ones the body and comments use.
 */
const isEmpty = (d: Draft) => draftKind(d) !== 'outline' && !d.body.trim() && !d.board && !(d.review && hasReviewContent(d.review, d.body));

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
  updatedAt?: number;
  body: string;
  board?: string;
}

export class DraftBook {
  /** Unsaved rule edits must be saved or cancelled before Send. */
  readonly behaviorEditing = new Set<string>();
  /** Sorted as the list shows them. Replaced on every change, for React. */
  drafts: Draft[] = [];
  selectedId?: string;
  /** Bumps on every change, as the snapshot React compares. */
  version = 0;
  private readonly saves = new SaveQueue((id) => this.write(id), () => this.emit(), DRAFT_SAVE_MS, DRAFT_RETRY_MS);
  /** Why the last save failed, until a write succeeds. */
  get saveError(): string | undefined { return this.saves.error; }
  private readonly listeners = new Set<() => void>();
  /** Pictures an edit took out of a draft, by id. An undo or a paste that brings the reference back finds them here. */
  private readonly loose = new Map<string, string>();
  /** Side tabs /open asked reviews to show, by draft. The review takes each once. */
  private readonly tabs = new Map<string, ReviewTab>();
  /** The file's text for an edited note whose file changed, by draft, until Reload. */
  private readonly changedFiles = new Map<string, string>();

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

  askTab(id: string, tab: ReviewTab): void {
    this.tabs.set(id, tab);
    this.emit();
  }

  takeTab(id: string): ReviewTab | undefined {
    const tab = this.tabs.get(id);
    this.tabs.delete(id);
    return tab;
  }

  /** Reads drafts from disk. Edits not saved yet win over what disk has. */
  async load(): Promise<void> {
    const saved = await this.host.listDrafts();
    const onDisk = new Map(saved.map((d) => [d.id, d]));

    // A queued or running save wins over a stale read, unless the note changed on disk after the last local edit, as `agent-brief note --id` does.
    // Main refuses a save older than what it stores, so a running one cannot land over the newer note.
    const replaced = new Set<string>();
    for (const d of this.drafts) {
      const disk = onDisk.get(d.id);
      if (!disk || !this.saves.has(d.id) || disk.updatedAt <= d.updatedAt) continue;
      this.saves.cancel(d.id);
      replaced.add(d.id);
    }
    const local = this.drafts.filter((d) => !replaced.has(d.id) && (this.saves.has(d.id) || (isEmpty(d) && !onDisk.has(d.id))));
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

  /** The first note with something in it on a tab, for Write mode. See `onTab`. */
  firstOnTab(sessionId: string | undefined, tabs: readonly string[]): Draft | undefined {
    return this.drafts.find((d) => !isEmpty(d) && inWrite(d) && onTab(d, sessionId, tabs));
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
   * the note as a copy of that output file, and a `review` makes it a review of an HTML file.
   */
  create(body = '', id?: string, sessionId?: string, source?: DraftSource, review?: DraftReview): Draft {
    const open = this.selected;
    if (open && isEmpty(open) && !body && !source && !review && !open.review && open.sessionId === sessionId && (id === undefined || open.id === id)) return open;
    const t = this.now();
    const draft: Draft = { id: id ?? newDraftId(t), body, status: 'note', rank: 0, createdAt: t, updatedAt: t };
    if (sessionId) draft.sessionId = sessionId;
    if (source) draft.source = source;
    if (review) draft.review = review;
    this.drafts = sortDrafts([draft, ...this.drafts]);
    this.select(draft.id);
    if (body) this.saves.schedule(draft.id);
    return draft;
  }

  /** Sets the body and keeps exactly the attachments it and the review's comments use. */
  edit(id: string, body: string): void {
    const draft = this.get(id);
    if (!draft) return;
    this.patch(id, { body, attachments: this.keep(draft, { body, review: draft.review }) });
  }

  /** The attachments `next` uses, from the draft, from ones taken out lately, or from other drafts. The rest wait loose. */
  private keep(draft: Draft, next: Pick<Draft, 'body' | 'review'>): Record<string, string> {
    const had = draft.attachments ?? {};
    const attachments: Record<string, string> = {};
    for (const imageId of keptImages(next)) {
      const data = had[imageId] ?? this.loose.get(imageId) ?? this.drafts.find((d) => d.attachments?.[imageId])?.attachments?.[imageId];
      if (data) attachments[imageId] = data;
    }
    for (const [imageId, data] of Object.entries(had)) if (!attachments[imageId]) this.keepLoose(imageId, data);
    return attachments;
  }

  setBehavior(id: string, doc: BehaviorDocument): void {
    const draft = this.get(id);
    if (!draft?.review || draft.review.behavior?.version === doc.version) return;
    if (!doc.rules.length && !doc.limitations.length && !draft.review.behavior) return;
    this.patch(id, { review: { ...draft.review, behavior: { ...doc, history: [] } } });
  }

  /** Adds a pin to a review, with the picture of its element when there is one. */
  addComment(id: string, comment: ReviewComment, picture?: string): void {
    const draft = this.get(id);
    if (!draft?.review) return;
    const review = { ...draft.review, comments: [...draft.review.comments, comment] };
    const attachments = { ...draft.attachments, ...(picture && comment.picture ? { [comment.picture]: picture } : {}) };
    this.patch(id, { review, attachments });
  }

  /** Notes an edit the pane saved to the file, for the review.md a Send writes. */
  addEdit(id: string, summary: string): void {
    const draft = this.get(id);
    if (!draft?.review) return;
    this.patch(id, { review: { ...draft.review, edits: [...(draft.review.edits ?? []), summary].slice(-MAX_EDITS) } });
  }

  /** Changes a pin's words. */
  editComment(id: string, commentId: string, text: string): void {
    const draft = this.get(id);
    if (!draft?.review) return;
    this.patch(id, { review: { ...draft.review, comments: draft.review.comments.map((c) => (c.id === commentId ? { ...c, text } : c)) } });
  }

  /**
   * Adds words to the end of a pin's or a note comment's, or to the overall words when `commentId` is undefined.
   * A review's overall words are its body. A note's are its annotations' `overall`, since its body is the note.
   */
  appendTo(id: string, commentId: string | undefined, words: string): void {
    const draft = this.get(id);
    const add = words.trim();
    if (!draft || !add) return;
    const joined = (text: string) => (text.trim() ? `${text.trimEnd()} ${add}` : add);
    if (commentId === undefined) {
      if (draft.review) this.edit(id, joined(draft.body));
      else this.setOverall(id, joined(draft.annotations?.overall ?? ''));
      return;
    }
    const comment = draft.review?.comments.find((c) => c.id === commentId);
    if (comment) this.editComment(id, commentId, joined(comment.text));
    const noted = draft.annotations?.comments.find((c) => c.id === commentId);
    if (noted) this.editNoteComment(id, commentId, joined(noted.text));
  }

  /** The draft holding a note comment, for words the mic heard. */
  ownerOfNoteComment(commentId: string): Draft | undefined {
    return this.drafts.find((d) => d.annotations?.comments.some((c) => c.id === commentId));
  }

  private annotate(id: string, change: (a: NoteAnnotations) => NoteAnnotations): void {
    const draft = this.get(id);
    if (!draft || draft.review) return;
    this.patch(id, { annotations: change(draft.annotations ?? { comments: [] }) });
  }

  /** Adds a comment on a passage of a note. */
  addNoteComment(id: string, comment: NoteComment): void {
    this.annotate(id, (a) => ({ ...a, comments: [...a.comments, comment] }));
  }

  editNoteComment(id: string, commentId: string, text: string): void {
    this.annotate(id, (a) => ({ ...a, comments: a.comments.map((c) => (c.id === commentId ? { ...c, text } : c)) }));
  }

  removeNoteComment(id: string, commentId: string): void {
    this.annotate(id, (a) => ({ ...a, comments: a.comments.filter((c) => c.id !== commentId) }));
  }

  /** Sets the words about the note as a whole. */
  setOverall(id: string, overall: string): void {
    this.annotate(id, (a) => {
      const { overall: _old, ...rest } = a;
      return overall ? { ...rest, overall } : rest;
    });
  }

  /** Drops the comments a Send delivered. Comments added or changed since stay. */
  clearSent(id: string, sent: NoteAnnotations): void {
    const delivered = new Map(sent.comments.map((c) => [c.id, c.text]));
    this.annotate(id, (a) => {
      const comments = a.comments.filter((c) => delivered.get(c.id) !== c.text);
      const overall = a.overall === sent.overall ? undefined : a.overall;
      return { comments, ...(overall ? { overall } : {}) };
    });
  }

  /** Takes a pin off a review. Its picture waits loose for a moment, like any removed picture. */
  removeComment(id: string, commentId: string): void {
    const draft = this.get(id);
    if (!draft?.review) return;
    const review = { ...draft.review, comments: draft.review.comments.filter((c) => c.id !== commentId) };
    this.patch(id, { review, attachments: this.keep(draft, { body: draft.body, review }) });
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

  /**
   * Compares a note opened from a file with the file's text now. A note with no edits takes
   * the new text, and its comments stay. An edited note keeps its text until `reloadSource`.
   */
  syncSource(id: string, text: string | undefined): SourceSync {
    const draft = this.get(id);
    const source = draft?.source;
    if (!draft || !source || text === undefined) return 'same';
    const known = source.text;
    if (sameText(draft.body, text) || (known !== undefined && sameText(known, text))) {
      if (this.changedFiles.delete(id)) this.emit();
      if (known === undefined || !sameText(known, text)) this.patch(id, { source: { ...source, text } });
      return 'same';
    }
    if (known !== undefined && sameText(draft.body, known)) {
      this.takeSource(id, text);
      return 'updated';
    }
    this.changedFiles.set(id, text);
    this.emit();
    return 'changed';
  }

  /** Reads the note's file and syncs the note with it. A file the app cannot read leaves the note as it is. */
  async refreshSource(id: string): Promise<SourceSync> {
    const draft = this.get(id);
    const sessionId = draft?.source?.sessionId ?? draft?.sessionId;
    if (!draft?.source || !sessionId) return 'same';
    const text = await this.host.readSource(sessionId, draft.source.path).catch(() => undefined);
    return this.syncSource(id, text);
  }

  /** Refreshes the note now and whenever its file changes on disk, until the returned stop runs. */
  watchSource(id: string): () => void {
    const draft = this.get(id);
    const sessionId = draft?.source?.sessionId ?? draft?.sessionId;
    const path = draft?.source?.path;
    if (!sessionId || !path) return () => {};
    void this.refreshSource(id);
    void this.host.watchOutput(sessionId, path).catch(() => undefined);
    const off = this.host.onOutputChanged((c) => {
      if (c.sessionId === sessionId && c.path === path) void this.refreshSource(id);
    });
    return () => {
      off();
      void this.host.unwatchOutput(sessionId, path).catch(() => undefined);
    };
  }

  /** The file's text when an edited note's file changed, or undefined while they agree. */
  changedSource(id: string): string | undefined {
    return this.changedFiles.get(id);
  }

  /** Replaces an edited note's text with its changed file's. */
  reloadSource(id: string): void {
    const text = this.changedFiles.get(id);
    if (text !== undefined) this.takeSource(id, text);
  }

  private takeSource(id: string, text: string): void {
    const draft = this.get(id);
    if (!draft?.source) return;
    this.changedFiles.delete(id);
    this.patch(id, { body: text, source: { ...draft.source, text }, attachments: this.keep(draft, { body: text, review: draft.review }) });
  }

  /** Links a draft to a board, or unlinks it. A board carries one draft, so others let go. */
  link(id: string, board: string | undefined): void {
    if (board) for (const d of this.drafts) if (d.board === board && d.id !== id) this.patch(d.id, { board: undefined }, false);
    this.patch(id, { board });
  }

  /** Names a draft, as an outline's title changes. */
  retitle(id: string, title: string): void {
    if (this.get(id)?.title !== title) this.patch(id, { title });
  }

  /** Files a draft under a session, or unfiles it. */
  file(id: string, sessionId: string | undefined): void {
    const draft = this.get(id);
    const source = draft?.source;
    this.patch(id, { sessionId, ...(source && !source.sessionId && draft?.sessionId ? { source: { ...source, sessionId: draft.sessionId } } : {}) });
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
    if (draft && (draft.body !== sent.body || draft.board !== sent.board || (sent.updatedAt !== undefined && draft.updatedAt !== sent.updatedAt))) {
      this.saves.schedule(id);
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
  flush(): Promise<void> {
    return this.saves.flush();
  }

  private patch(id: string, change: Partial<Draft>, emit = true): void {
    const at = this.drafts.findIndex((d) => d.id === id);
    if (at === -1) return;
    // Edit times only move forward, so a clock set back never makes an edit look older than what main stores.
    const next = { ...this.drafts[at], ...change, updatedAt: Math.max(this.now(), this.drafts[at]!.updatedAt + 1) };
    if (!next.board) delete next.board;
    if (!next.sessionId) delete next.sessionId;
    if (!next.attachments || Object.keys(next.attachments).length === 0) delete next.attachments;
    if (next.annotations && !next.annotations.comments.length && !next.annotations.overall) delete next.annotations;
    const list = [...this.drafts];
    list[at] = next;
    this.drafts = sortDrafts(list);
    this.saves.schedule(id);
    if (emit) this.emit();
  }

  /** The store owns empty-draft deletion; the queue owns scheduling and retries. */
  private async write(id: string): Promise<boolean> {
    const draft = this.get(id);
    if (!draft) return false;
    if (isEmpty(draft)) await this.host.deleteDraft(id);
    else await this.host.saveDraft(draft);
    return true;
  }

  private drop(id: string): void {
    this.saves.cancel(id);
    this.changedFiles.delete(id);
    this.drafts = this.drafts.filter((d) => d.id !== id);
    if (this.selectedId === id) this.selectedId = undefined;
  }
}
