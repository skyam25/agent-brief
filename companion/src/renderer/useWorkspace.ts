/** Owns workspace transitions: session tabs, drafts, recording and main-process events. */
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { SessionsResponse } from '../protocol';
import type { CompanionApi, InitInfo, Mode } from '../shared/ipc';
import type { BoardCommentsStore } from './board-comments';
import type { BoardController } from './controller';
import { onTab, type DraftBook } from './drafts';
import type { TemplateShelf } from './templates';
import type { ToastKind } from './Toast';
import { useBriefTabs, type TabScope } from './useBriefTabs';
import { useVoice } from './useVoice';
import { flushWorkspaces, workspaceReply } from './workspace-boards';

interface WorkspaceDeps {
  host: CompanionApi;
  info: InitInfo;
  controller: BoardController;
  book: DraftBook;
  shelf: TemplateShelf;
  comments: BoardCommentsStore;
  board: string;
  notify: (message: string, kind?: ToastKind) => void;
  report: (what: string) => (err: unknown) => void;
}

export function useWorkspace({ host, info, controller, book, shelf, comments, board, notify, report }: WorkspaceDeps) {
  const [sessions, setSessions] = useState<SessionsResponse>(info.sessions);
  const [newBoardRequest, setNewBoardRequest] = useState(0);
  const [mode, setModeState] = useState<Mode>(info.mode);
  const [focusRequest, setFocusRequest] = useState(0);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const tabScope = useRef<TabScope>({ tabs: [] });

  const voice = useVoice({
    host,
    book,
    controller,
    comments,
    board,
    mode,
    modeRef,
    notify,
  });

  const { reviewVoice, reviewing, toggleReviewVoice } = voice;

  /** Sketch has a mic, which talks to the board's pins. Review mode has one while a review is open, and Write while a note is. */
  const onMicrophone = reviewing || mode === 'sketch' ? () => void toggleReviewVoice() : undefined;

  /** Switches modes. Write opens the first draft, or a new note when there is none. */
  const changeMode = useCallback(
    (next: Mode) => {
      setModeState(next);
      host.setMode(next);
      // Pins belong to their mode, so the mic on them stops when the mode changes.
      if (next !== modeRef.current) void reviewVoice.stop();
      if (next === 'sketch') return;
      // Only Sketch has a mic button, so a recording stops here and waits for the next sketch Send.
      if (controller.recorder.recording) void controller.recorder.stop();
      if (next !== 'write') return;
      const { sessionId, tabs } = tabScope.current;
      const open = book.selected;
      if (!open || open.review || !onTab(open, sessionId, tabs)) {
        const first = book.firstOnTab(sessionId, tabs);
        if (first) book.select(first.id);
        else book.create('', undefined, sessionId);
      }
      setFocusRequest((n) => n + 1);
    },
    [host, book, controller, reviewVoice],
  );
  /** Opens a draft in its mode: a review in Review, a note in Write. */
  const openDraft = useCallback(
    (id: string) => {
      book.select(id);
      changeMode(book.get(id)?.review ? 'review' : 'write');
    },
    [book, changeMode],
  );
  /**
   * Opens a draft main named, filing it under `sessionId` when it has no session yet.
   * With `shows`, the panel takes the draft's mode in the same tick as the selection. A render between
   * the two would draw Review without its draft, and Review then opens an output of its own.
   */
  const showDraft = useCallback(
    async (id: string, sessionId?: string, shows = false) => {
      if (!book.get(id)) await book.load();
      if (sessionId && book.get(id) && !book.get(id)!.sessionId) book.file(id, sessionId);
      book.select(id);
      if (shows) changeMode(book.get(id)?.review ? 'review' : 'write');
    },
    [book, changeMode],
  );
  const openBoard = useCallback(
    (name: string) => {
      changeMode('sketch');
      if (name !== controller.board) void controller.switchTo(name).catch(report('switch boards'));
    },
    [changeMode, controller],
  );

  const tabs = useBriefTabs({
    host,
    book,
    controller,
    sessions,
    modeRef,
    tabScope,
    changeMode,
    showDraft,
    report,
  });
  const { leaveEnded, showTab } = tabs;

  useEffect(() => {
    const subscriptions = [
      host.onSessions(setSessions),
      host.onNewBoard(() => {
        changeMode('sketch');
        setNewBoardRequest((n) => n + 1);
      }),
      host.onNewNote(({ text, id, sessionId, source, review, tab }) => {
        // A note for no session comes with the Send target cleared, so the Notes tab shows.
        if (!sessionId) leaveEnded();
        // Main looks for an open review or file note on disk, and one edited a moment ago may not be there yet.
        const kept = book.drafts.find(
          (d) => d.sessionId === sessionId && ((review && d.review?.path === review.path) || (source && d.source?.path === source.path)),
        );
        if (kept) book.select(kept.id);
        if (kept && source) book.syncSource(kept.id, source.text ?? text);
        const shown = kept ?? book.create(text, id, sessionId, source, review);
        if (review && tab) book.askTab(shown.id, tab);
        changeMode(review ? 'review' : 'write');
      }),
      host.onOpenDraft(({ id, sessionId, tab }) => {
        showTab(sessionId);
        void showDraft(id, sessionId, true).then(() => {
          void book.refreshSource(id);
          if (tab && book.get(id)?.review) book.askTab(id, tab);
        });
      }),
      // A note from `agent-brief note` joins the list. The open note and the mode stay.
      host.onDraftsChanged(() => void book.load()),
      host.onVisibility((visible) => {
        controller.panelVisible = visible;
        if (!visible) leaveEnded();
        if (!visible) void Promise.all([book.flush(), shelf.flush(), comments.flush(), flushWorkspaces()]).catch(report('save changes'));
      }),
    ];
    controller.panelVisible = info.panelVisible;
    return () => {
      for (const off of subscriptions) if (typeof off === 'function') off();
    };
  }, [host, controller, book, shelf, comments, changeMode, showDraft, leaveEnded, showTab, info.panelVisible]);

  const requestSubscription = useRef<void | (() => void)>(undefined);
  useEffect(() => () => { requestSubscription.current?.(); }, []);
  const onReady = useCallback(
    (api: ExcalidrawImperativeAPI) => {
      requestSubscription.current?.();
      requestSubscription.current = host.onRequest(async (req) => {
        // Draft saves never block the board's own flush before quitting.
        if (req.op === 'flush') await Promise.all([book.flush(), shelf.flush(), comments.flush(), flushWorkspaces()]).catch(() => undefined);
        // A feedback workspace open in Review answers for its own board.
        const held = workspaceReply(req);
        if (held) return held;
        // /sketch shows a board, which brings Sketch mode forward. A tab switch picks its own mode.
        if (req.op === 'show' && !(req.args as { fromSwitch?: boolean }).fromSwitch) changeMode('sketch');
        return controller.reply(req);
      });
      host.ready();
      if (info.testMode) Object.assign(window, { __board: controller, __excalidraw: api, __drafts: book, __templates: shelf });
    },
    [controller, host, book, shelf, comments, changeMode, info.testMode],
  );

  return { ...voice, ...tabs, sessions, mode, modeRef, focusRequest, newBoardRequest, changeMode, openDraft, openBoard, onMicrophone, onReady };
}
