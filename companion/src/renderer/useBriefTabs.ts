/** The session tabs: which one is on show, and switching, leaving and closing them. */

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { SessionsResponse } from '../protocol';
import type { CompanionApi, Mode, SessionBriefEntry } from '../shared/ipc';
import type { BoardController } from './controller';
import { onTab, type DraftBook } from './drafts';

/** The tab on show: its session, or undefined for Unfiled, with every session tab's id. */
export interface TabScope {
  sessionId?: string;
  tabs: string[];
}

export interface BriefTabsDeps {
  host: CompanionApi;
  book: DraftBook;
  controller: Pick<BoardController, 'board' | 'switchTo'>;
  sessions: SessionsResponse;
  modeRef: RefObject<Mode>;
  /** Written each render, for code that runs outside it. */
  tabScope: RefObject<TabScope>;
  changeMode: (mode: Mode) => void;
  showDraft: (id: string, sessionId?: string, shows?: boolean) => Promise<void>;
  report: (what: string) => (err: unknown) => void;
}

export interface PanelTabs {
  briefs: SessionBriefEntry[];
  /** The active tab's session, or undefined for Unfiled. */
  activeBrief: string | undefined;
  active: SessionBriefEntry | undefined;
  /** Shows a session's tab. With `open`, that draft opens in Write instead of what the tab last showed. */
  switchBrief: (sessionId: string, open?: string) => Promise<void>;
  openNotes: () => void;
  closeBrief: (sessionId: string) => void;
  /** Drops an opened ended session, so the tab follows the Send target again. */
  leaveEnded: () => void;
  /** Shows the tab of a draft main opened: an ended session's here, Unfiled for none. A live session arrives as the Send target. */
  showTab: (sessionId: string | undefined) => void;
}

export function useBriefTabs({ host, book, controller, sessions, modeRef, tabScope, changeMode, showDraft, report }: BriefTabsDeps): PanelTabs {
  const [briefs, setBriefs] = useState<SessionBriefEntry[]>([]);
  /** An ended session's tab the user opened. It has no target, so it is the active tab only here. */
  const [endedActive, setEndedActive] = useState<string>();

  useEffect(() => {
    void host.listBriefs().then(setBriefs);
    return host.onBriefs(setBriefs);
  }, [host]);

  // The active tab is the Send target's brief, or an ended session's brief the user opened.
  const target = sessions.targetSessionId;
  const activeBrief = briefs.some((b) => b.sessionId === target) ? target : briefs.some((b) => b.sessionId === endedActive) ? endedActive : undefined;
  tabScope.current = { sessionId: activeBrief, tabs: briefs.map((b) => b.sessionId) };

  const switchBrief = (sessionId: string, open?: string) => {
    const brief = briefs.find((b) => b.sessionId === sessionId);
    setEndedActive(brief && !brief.isLive ? sessionId : undefined);
    return host
      .switchBrief(sessionId)
      .then(async (opened) => {
        if (open) {
          await showDraft(open);
          changeMode('write');
          return;
        }
        if ('draftId' in opened) await showDraft(opened.draftId);
        // Review and Initiative stay open across a switch; otherwise the tab shows what it opened.
        if (modeRef.current !== 'review' && modeRef.current !== 'initiative') changeMode('draftId' in opened ? 'write' : 'sketch');
      })
      .catch(report('open that brief'));
  };
  /** Unfiled: no Send target and no session, on an unfiled board main picks. Review needs a session, so it falls back to Write. */
  const openNotes = () => {
    setEndedActive(undefined);
    if (modeRef.current === 'review') changeMode('write');
    void host
      .openUnfiled()
      .then(({ board }) => (board !== controller.board ? controller.switchTo(board) : undefined))
      .catch(report('open Unfiled'));
  };
  const leaveEnded = useCallback(() => setEndedActive(undefined), []);
  const known = useRef({ briefs, sessions });
  known.current = { briefs, sessions };
  const showTab = useCallback(
    (sessionId: string | undefined) => {
      const brief = sessionId ? known.current.briefs.find((b) => b.sessionId === sessionId) : undefined;
      if (brief?.isLive || known.current.sessions.sessions.some((x) => x.sessionId === sessionId)) return;

      // An ended session opens its tab. One whose tab was closed lists its notes under Unfiled.
      setEndedActive(brief ? sessionId : undefined);

      // Write checks the tab before React renders it.
      tabScope.current = { ...tabScope.current, sessionId: brief ? sessionId : undefined };
    },
    [tabScope],
  );
  const closeBrief = (sessionId: string) => {
    if (endedActive === sessionId) setEndedActive(undefined);
    void host.forgetBrief(sessionId).catch(report('close the tab'));
  };

  // A tab switch leaves the open draft when it belongs to another tab, and opens one that belongs here.
  useEffect(() => {
    const open = book.selected;
    if (!open || onTab(open, activeBrief, tabScope.current.tabs)) return;
    book.select(book.firstOnTab(activeBrief, tabScope.current.tabs)?.id);
  }, [activeBrief, book, tabScope]);

  return {
    briefs,
    activeBrief,
    active: briefs.find((b) => b.sessionId === activeBrief),
    switchBrief,
    openNotes,
    closeBrief,
    leaveEnded,
    showTab,
  };
}
