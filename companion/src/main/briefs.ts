/** Each Claude Code session's latest board and note, so /sketch, /write and the tabs reopen them. */

import { rmSync } from 'node:fs';
import { outputsFile, type SessionInfo, type SessionsResponse } from '../protocol';
import { newDraftId } from '../shared/drafts';
import { isWorkspaceBoard } from '../shared/feedback-workspace';
import { CH, type BoardEntry, type NewNote, type OpenDraft, type SessionBriefEntry } from '../shared/ipc';
import type { DraftStore } from './drafts';
import { resumeCommand } from './launch';
import {
  boardHolder,
  detachBoard,
  forgetBoard,
  liveFields,
  moveBoard,
  refreshLive,
  remember,
  renameBoard,
  sketchBoard,
  type SessionBrief,
  type SessionBriefs,
} from './session-briefs';
import type { BoardStore, StateFile } from './store';

export interface BriefsDeps {
  state: StateFile;
  store: BoardStore;
  drafts: DraftStore;
  sessions: () => SessionsResponse;
  send: (channel: string, ...args: unknown[]) => void;
  /** Runs after each publish, for the file watches that follow the briefs. */
  onPublish: () => void;
}

export class Briefs {
  constructor(private readonly deps: BriefsDeps) {}

  all(): SessionBriefs {
    return this.deps.state.state.sessionBriefs ?? {};
  }

  get(sessionId: string): SessionBrief | undefined {
    return this.all()[sessionId];
  }

  live(sessionId: string | undefined): SessionInfo | undefined {
    return this.deps.sessions().sessions.find((x) => x.sessionId === sessionId);
  }

  /** The session's folder, from the live session or the one its brief kept. */
  cwdOf(sessionId: string): string | undefined {
    return this.live(sessionId)?.cwd ?? this.get(sessionId)?.cwd;
  }

  /** The tabs the panel shows, newest first. */
  entries(): SessionBriefEntry[] {
    const { store, drafts } = this.deps;
    const { targetSessionId } = this.deps.sessions();
    return Object.entries(this.all())
      .sort(([, a], [, b]) => b.at - a.at)
      .map(([sessionId, b]) => {
        const live = this.live(sessionId);
        const draft = b.draftId ? drafts.get(b.draftId) : undefined;
        const board = b.board && store.exists(b.board) ? b.board : undefined;
        const { title, cwd, host } = { title: b.title ?? 'Ended session', cwd: b.cwd, host: b.host, ...(live ? liveFields(live) : {}) };
        return {
          sessionId,
          title,
          ...(cwd ? { cwd } : {}),
          ...(host ? { host } : {}),
          ...(!live && cwd ? { resume: resumeCommand(cwd, sessionId) } : {}),
          ...(board ? { board } : {}),
          ...(draft ? { draftId: draft.id } : {}),
          ...(b.last ? { last: b.last } : {}),
          ...(b.trackItems ? { trackItems: true } : {}),
          ...(live?.mode ? { mode: live.mode, ...(live.fidelity ? { fidelity: live.fidelity } : {}) } : {}),
          at: b.at,
          isLive: !!live,
          isTarget: targetSessionId === sessionId,
          hasContent: (!!board && !store.isEmpty(board)) || !!draft?.body.trim() || !!draft?.attachments,
        };
      });
  }

  publish(): void {
    this.deps.send(CH.briefs, this.entries());
    this.deps.onPublish();
  }

  /**
   * Records what a session opened. Claude Code opening it moves its tab to the front;
   * a switch in the panel (`touch: false`) keeps the tab where it is.
   */
  remember(sessionId: string, patch: Partial<Omit<SessionBrief, 'at'>>, touch = true): void {
    const live = this.live(sessionId);
    const known = live ? liveFields(live) : {};
    const at = touch ? Date.now() : (this.get(sessionId)?.at ?? Date.now());
    this.save(remember(this.all(), sessionId, { ...patch, ...known }, at));
    this.publish();
  }

  /** Saves a patch without moving the session's tab or publishing. */
  keepPlace(sessionId: string, patch: Partial<Omit<SessionBrief, 'at'>>): void {
    const at = this.get(sessionId)?.at ?? Date.now();
    this.save(remember(this.all(), sessionId, patch, at));
  }

  /** Republishes when a board or note a tab shows changes, for its unsent-content mark. */
  touched(what: { board?: string; draftId?: string }): void {
    const shown = Object.values(this.all()).some((b) => (what.board && b.board === what.board) || (what.draftId && b.draftId === what.draftId));
    if (shown) this.publish();
  }

  /** Takes the live sessions' titles and folders, then republishes. */
  refresh(live: SessionInfo[]): void {
    const refreshed = refreshLive(this.all(), live);
    if (refreshed !== this.all()) this.save(refreshed);
    this.publish();
  }

  renameBoard(from: string, to: string): void {
    this.save(renameBoard(this.all(), from, to));
    this.publish();
  }

  forgetBoard(name: string): void {
    this.save(forgetBoard(this.all(), name));
    this.publish();
  }

  /** Takes a board out of a session's brief. */
  detach(sessionId: string, board: string): void {
    this.save(detachBoard(this.all(), sessionId, board));
    this.publish();
  }

  /** Files boards under one session, out of any other brief. */
  move(boards: string[], sessionId: string): void {
    this.save(boards.reduce((all, board) => moveBoard(all, board, sessionId), this.all()));
    this.publish();
  }

  forget(sessionId: string): void {
    const { [sessionId]: _gone, ...rest } = this.all();
    this.save(rest);
    this.publish();
  }

  /** The session whose brief holds a board, live or ended. A live holder comes first. */
  holderOf(board: string): string | undefined {
    return boardHolder(this.all(), board, (id) => !!this.live(id));
  }

  /** Every board, each with the session that holds it. */
  boardsWithHolders(): BoardEntry[] {
    // Feedback workspace boards open from their item, never from a board list.
    return this.deps.store.list().filter((b) => !isWorkspaceBoard(b.name)).map((b) => {
      const sessionId = this.holderOf(b.name);
      return sessionId ? { ...b, sessionId } : b;
    });
  }

  /** The board /sketch opens for a session that names none. */
  boardFor(sessionId: string): string {
    const { state, store } = this.deps;
    return sketchBoard({
      sessionId,
      briefs: this.all(),
      current: state.state.currentBoard,
      now: Date.now(),
      exists: (n) => store.exists(n),
      isEmpty: (n) => store.isEmpty(n),
    }).board;
  }

  /**
   * Opens a note in Write mode: the session's last one when it still exists and no text came, else a new one.
   * A note opened for a session is filed under it.
   */
  openNote(sessionId: string | undefined, text: string | undefined): void {
    const keptId = sessionId && !text ? this.get(sessionId)?.draftId : undefined;
    const kept = keptId ? this.deps.drafts.get(keptId) : undefined;
    if (kept) this.showDraft(sessionId, kept.id);
    else this.startNote({ text, id: newDraftId(), ...(sessionId ? { sessionId } : {}) });
  }

  /** Shows a saved draft in Write mode and records it as the session's note. */
  showDraft(sessionId: string | undefined, id: string, touch = true): void {
    const open: OpenDraft = { id, ...(sessionId ? { sessionId } : {}) };
    this.deps.send(CH.openDraft, open);
    if (sessionId) this.remember(sessionId, { draftId: id, last: 'draft' }, touch);
  }

  /** Starts a new note in Write mode and records it as the session's note. */
  startNote(note: NewNote & { id: string }, touch = true): void {
    this.deps.send(CH.newNote, note);
    if (note.sessionId) this.remember(note.sessionId, { draftId: note.id, last: 'draft' }, touch);
  }

  private save(sessionBriefs: SessionBriefs): void {
    const before = this.all();
    this.deps.state.update({ sessionBriefs });
    for (const [id, b] of Object.entries(before)) {
      if (!(id in sessionBriefs) && b.cwd && !this.live(id)) dropOutputsFile(b.cwd, id);
    }
  }
}

/** Deletes an ended session's outputs record once its brief goes. The outputs themselves stay. */
function dropOutputsFile(cwd: string, sessionId: string): void {
  try {
    rmSync(outputsFile(cwd, sessionId), { force: true });
  } catch {
    // A record left behind does no harm.
  }
}
