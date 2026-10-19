/** Send: builds what each mode hands over, delivers it, and clears what went out. */

import { useRef, type RefObject } from 'react';
import { hasBoardComments } from '../shared/board-comments';
import { draftImages } from '../shared/drafts';
import { hasReviewContent } from '../shared/review';
import type { CompanionApi, Decision, Draft, Launcher, Mode, Outgoing, SendResult } from '../shared/ipc';
import { findSlots } from '../shared/slots';
import type { BoardCommentsStore } from './board-comments';
import type { BoardController } from './controller';
import type { DraftBook, SentRevision } from './drafts';
import { focusFirstSlot } from './editor/RichEditor';
import { DISCOVER_PROMPT } from './initiatives';
import type { ItemsStore } from './items';
import type { ReviewVoice } from './review-voice';
import type { ToastKind } from './Toast';

/** A fixed text to hand a session, such as Feedback's decisions. `onSent` runs once it went out and throws when its follow-up failed. */
export interface FixedSend {
  text: string;
  onSent?: () => Promise<void>;
}

/** The decisions an Items Send delivers, so success can clear them. */
interface Decided {
  sessionId: string;
  decisions: Decision[];
}

export interface SendDeps {
  host: CompanionApi;
  book: DraftBook;
  controller: BoardController;
  comments: BoardCommentsStore;
  items: ItemsStore;
  reviewVoice: ReviewVoice;
  modeRef: RefObject<Mode>;
  /** The session tab on show, which Review mode sends decisions for. */
  activeBrief: string | undefined;
  notify: (text: string, kind?: ToastKind) => void;
  setChooserOpen: (open: boolean) => void;
}

export interface PanelSend {
  send: () => Promise<void>;
  sendTo: (sessionId: string) => Promise<void>;
  sendNew: (cwd: string, via: Launcher) => Promise<void>;
  copyPrompt: (cwd: string) => Promise<void>;
  openChooser: (open: boolean) => void;
  /** Hands a running session what `build` makes, or says why `build` made nothing. */
  sendText: (sessionId: string, build: () => Promise<FixedSend | string>) => Promise<void>;
}

/** The payload fields a draft adds: the pictures its body references and the output file it was copied from, when it has them. */
const fromDraft = (draft: Draft) => {
  const images = draftImages(draft);
  return { ...(images.length ? { images } : {}), ...(draft.source ? { sourcePath: draft.source.path } : {}) };
};

export function useSend({ host, book, controller, comments, items, reviewVoice, modeRef, activeBrief, notify, setChooserOpen }: SendDeps): PanelSend {
  /** The text whose empty slots were already pointed out, so a second Send goes through. */
  const slotsWarned = useRef<string>(undefined);
  /** True from the press of Send until main answers, so a second press cannot send twice. */
  const sending = useRef(false);

  const checkSlots = (text: string): string | undefined => {
    const count = findSlots(text).length;
    if (!count || slotsWarned.current === text) return undefined;
    slotsWarned.current = text;
    return `${count === 1 ? '1 empty slot' : `${count} empty slots`}. Send again to send anyway.`;
  };

  /** Why Send in Review mode has no decisions to send, if it has not. */
  const itemsBlocker = (): string | undefined => {
    if (!activeBrief) return "Open a session's items first.";
    if (items.decisions(activeBrief).length === 0) return 'Decide something first.';
    return undefined;
  };

  /**
   * What Send hands over. Sketch mode sends the board with any draft pulled in.
   * Write mode sends the open draft with the board it carries, if any.
   * Review mode sends the open review, or the decisions on the session's items.
   * Initiative mode sends the discover prompt.
   */
  const outgoing = async (): Promise<
    { payload: Outgoing; clearsBoard: boolean; sent?: SentRevision; decided?: Decided; pinned?: string; onSent?: () => Promise<void> } | string
  > => {
    if (modeRef.current === 'initiative') return { payload: { text: DISCOVER_PROMPT }, clearsBoard: false };
    if (modeRef.current === 'review') {
      const open = book.selected;
      if (open?.review) {
        if (book.behaviorEditing.has(open.id)) return 'Save or cancel the behavior edit before sending.';
        if (!hasReviewContent(open.review, open.body)) return 'Pin a comment first.';
        // Words still turning into text land before the Send reads the draft.
        await reviewVoice.stop();
        await book.flush();
        const d = book.get(open.id) ?? open;
        const review = { ...d.review!, ...(d.body.trim() ? { body: d.body } : {}) };
        return { payload: { text: d.body, draftId: d.id, review, ...fromDraft(d) }, clearsBoard: false, sent: { body: d.body } };
      }
      const blocked = itemsBlocker();
      if (blocked) return blocked;
      const decided = { sessionId: activeBrief!, decisions: items.decisions(activeBrief!) };
      const { draft } = await host.saveDecisions(decided.sessionId, decided.decisions);
      return { payload: { text: draft }, clearsBoard: false, decided };
    }
    if (modeRef.current === 'sketch') {
      const linked = book.linkedTo(controller.board);
      const unfilled = linked && checkSlots(linked.body);
      if (unfilled) return unfilled;
      await book.flush();
      // Words still turning into text land on their pins before the Send reads them.
      await reviewVoice.stop();

      // Comments review the board, so a Send with them keeps the board and clears only the pins.
      const board = controller.board;
      const pinned = comments.of(board);
      const reviewed = hasBoardComments(pinned);
      const payload = { ...(await controller.payload(reviewed ? pinned.pins : undefined)), ...(reviewed ? { comments: pinned } : {}) };
      const kept = reviewed ? { clearsBoard: false, pinned: board } : { clearsBoard: true };
      if (!linked) return { payload, ...kept };
      return {
        payload: { ...payload, text: linked.body, draftId: linked.id, ...fromDraft(linked) },
        ...kept,
        sent: { body: linked.body, board: linked.board },
      };
    }
    const draft = book.selected?.review ? undefined : book.selected;
    if (!draft || (!draft.body.trim() && !draft.board)) return 'Write something first.';
    const unfilled = checkSlots(draft.body);
    if (unfilled) {
      focusFirstSlot('draft-body');
      return unfilled;
    }
    await book.flush();
    const sent = { body: draft.body, board: draft.board };
    if (!draft.board) return { payload: { text: draft.body, draftId: draft.id, ...fromDraft(draft) }, clearsBoard: false, sent };
    if (draft.board !== controller.board) await controller.switchTo(draft.board);
    return { payload: { ...(await controller.payload()), text: draft.body, draftId: draft.id, ...fromDraft(draft) }, clearsBoard: true, sent };
  };

  const fixedOutgoing = async (build: () => Promise<FixedSend | string>): ReturnType<typeof outgoing> => {
    const fixed = await build();
    return typeof fixed === 'string' ? fixed : { payload: { text: fixed.text }, clearsBoard: false, onSent: fixed.onSent };
  };

  /** Builds the payload, or a fixed one, hands it over, and hides the panel once it went out. */
  const deliver = async (handOff: (payload: Outgoing) => Promise<SendResult>, fixed?: () => Promise<FixedSend | string>) => {
    if (sending.current) return;
    sending.current = true;
    setChooserOpen(false);
    notify('Preparing…', 'progress');
    try {
      const out = fixed ? await fixedOutgoing(fixed) : await outgoing();
      if (typeof out === 'string') {
        notify(out);
        return;
      }
      const result = await handOff(out.payload);
      // A follow-up that failed keeps the panel up, so the user sees what is left undone.
      if (result.ok && out.onSent) {
        const failed = await out.onSent().then(() => undefined, (err: Error) => err.message);
        if (failed) {
          notify(`Sent, but ${failed}`, 'error');
          return;
        }
      }
      notify(result.message, result.ok ? 'sent' : 'error');
      if (result.ok) {
        if (out.clearsBoard) controller.clearBoard();
        if (out.pinned) {
          comments.clear(out.pinned);
          controller.resetSession();
        }
        if (out.payload.draftId && out.sent) book.consume(out.payload.draftId, out.sent);
        if (out.decided) {
          items.clear(out.decided.sessionId, out.decided.decisions);
          void items.load(out.decided.sessionId).catch(() => undefined);
        }
        host.hidePanel();
      }
    } catch (err) {
      notify(`Send failed: ${(err as Error).message}`, 'error');
    } finally {
      sending.current = false;
    }
  };

  const send = () => deliver((p) => host.send(p));
  /** Holds the Send guard while the target changes, so a second pick cannot retarget this Send. */
  const sendTo = async (sessionId: string) => {
    if (sending.current) return;
    sending.current = true;
    try {
      await host.setTarget(sessionId);
    } finally {
      sending.current = false;
    }
    await deliver((p) => host.send(p));
  };
  const sendText = async (sessionId: string, build: () => Promise<FixedSend | string>) => {
    if (sending.current) return;
    sending.current = true;
    try {
      await host.setTarget(sessionId);
    } finally {
      sending.current = false;
    }
    await deliver((p) => host.send(p), build);
  };
  const sendNew = (cwd: string, via: Launcher) => deliver((p) => host.sendNew(p, { cwd, via }));
  const copyPrompt = (cwd: string) => deliver((p) => host.copyPrompt(p, cwd));
  /** An empty note says so before any session is picked. */
  const openChooser = (open: boolean) => {
    const blocked = open ? chooserBlocker() : undefined;
    if (blocked) {
      notify(blocked);
      return;
    }
    setChooserOpen(open);
  };
  /** Why the session picker has nothing to send yet, if it has not. */
  const chooserBlocker = (): string | undefined => {
    const draft = book.selected;
    if (modeRef.current === 'review') {
      if (!draft?.review) return itemsBlocker();
      return hasReviewContent(draft.review, draft.body) ? undefined : 'Pin a comment first.';
    }
    if (modeRef.current !== 'write') return undefined;
    const note = draft?.review ? undefined : draft;
    return !note || (!note.body.trim() && !note.board) ? 'Write something first.' : undefined;
  };

  return { send, sendTo, sendNew, copyPrompt, openChooser, sendText };
}
