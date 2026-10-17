import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { SessionsResponse } from '../protocol';
import type { CompanionApi, InitInfo, Mode, SessionBriefEntry, Settings, Theme, UpdateStatus } from '../shared/ipc';
import { BoardCanvas } from './BoardCanvas';
import { BoardPicker, LayoutSwitch } from './BoardPicker';
import { fallbackBoard } from './boardScope';
import { BoardController, parseScene, type LoadedScene } from './controller';
import { draftTitle } from '../shared/drafts';
import { DraftBook, onTab } from './drafts';
import { TemplateShelf } from './templates';
import { shouldHideOnEscape } from './escape';
import { HistoryPopover } from './HistoryPopover';
import { CloseIcon, GearIcon, HistoryIcon, NotesIcon, SidebarIcon } from './Icons';
import { useStore } from './hooks';
import { ItemsStore } from './items';
import { Mic, VoiceStrip } from './Mic';
import { OutputsStore } from './outputs';
import { PullIn } from './PullIn';
import { ResumeRow } from './ResumeRow';
import { ReviewMode } from './ReviewMode';
import { SessionSidebar, sidebarOrder, useSidebar } from './SessionSidebar';
import { SendTo } from './SendTo';
import { SettingsPopover } from './SettingsPopover';
import { Toast, type ToastKind, type ToastMessage } from './Toast';
import { PromptBanner, TopStrip } from './TopStrip';
import { useBoards } from './useBoards';
import { useBriefTabs, type TabScope } from './useBriefTabs';
import { usePanelKeys } from './usePanelKeys';
import { useSend } from './useSend';
import { useVoice } from './useVoice';
import { WriteView } from './WriteView';

interface Boot {
  info: InitInfo;
  controller: BoardController;
  scene: LoadedScene;
  book: DraftBook;
  shelf: TemplateShelf;
  items: ItemsStore;
  outputs: OutputsStore;
}

async function boot(host: CompanionApi): Promise<Boot> {
  const info = await host.init();
  const { scene, notes } = await host.loadBoard(info.currentBoard);
  const loaded = parseScene(scene);
  const controller = new BoardController(host, { board: info.currentBoard, notes, scene: loaded });
  const book = new DraftBook(host);
  const shelf = new TemplateShelf(host);
  const items = new ItemsStore(host);
  const outputs = new OutputsStore(host);
  await Promise.all([book.load(), shelf.load()]);
  // A launch in Write mode opens on the Notes tab, at the top of its list.
  const first = book.drafts.find((d) => !d.sessionId);
  if (info.mode === 'write' && first) book.select(first.id);
  return { info, controller, scene: loaded, book, shelf, items, outputs };
}

export function App({ host }: { host: CompanionApi }) {
  const [booted, setBooted] = useState<Boot>();
  useEffect(() => {
    void boot(host).then(setBooted);
  }, [host]);
  if (!booted) return null;
  return <Panel host={host} {...booted} />;
}

/** An IPC error without Electron's "Error invoking remote method" wrapper. */
function errorText(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '');
}

/** The view tabs, Sketch, Write and Review, in the middle of the strip. Review needs a session tab. */
function ModeSwitch(props: { mode: Mode; hasReview: boolean; onChange: (mode: Mode) => void }) {
  const tab = (mode: Mode, label: string, key: string) => (
    <button
      role="tab"
      className="ghost"
      aria-selected={props.mode === mode}
      title={`${label} (${key})`}
      onClick={() => props.onChange(mode)}
      data-testid={`mode-${mode}`}
    >
      {label}
    </button>
  );
  return (
    <div className="cluster modes" role="tablist" aria-label="View">
      {tab('sketch', 'Sketch', '⌘1')}
      {tab('write', 'Write', '⌘2')}
      {props.hasReview && tab('review', 'Review', '⌘3')}
    </div>
  );
}

/** The breadcrumb's first segment: the active session, or Unfiled. A live session's segment brings its terminal forward. */
function SessionCrumb(props: { brief?: SessionBriefEntry; onFocus: (sessionId: string) => void }) {
  const b = props.brief;
  if (!b) {
    return (
      <span className="crumb-session unfiled" title="Boards and notes that belong to no session" data-testid="crumb-session">
        <span className="name">Unfiled</span>
      </span>
    );
  }
  const state = b.isLive ? 'Running in Claude Code' : 'Session ended';
  const label = (
    <>
      <span className={b.isLive ? 'dot live' : 'dot'} aria-label={state} />
      <span className="name">{b.title}</span>
    </>
  );
  if (!b.isLive) {
    return (
      <span className="crumb-session" title={`${b.title}\n${state}`} data-testid="crumb-session">
        {label}
      </span>
    );
  }
  return (
    <button
      className="ghost crumb-session"
      title={`${b.title}\n${state}\nClick to bring its terminal forward`}
      onClick={() => props.onFocus(b.sessionId)}
      data-testid="crumb-session"
    >
      {label}
    </button>
  );
}

/** The breadcrumb's note segment in Write view: the open note's title. */
function NoteCrumb(props: { book: DraftBook }) {
  const draft = useStore(props.book).selected;
  if (!draft) return null;
  const title = draft.title || draftTitle(draft.body, 40) || 'Untitled note';
  return (
    <>
      <span className="sep" aria-hidden="true">
        ›
      </span>
      <span className="crumb-note" title={title} data-testid="crumb-note">
        {title}
      </span>
    </>
  );
}

function Panel({ host, info, controller, scene, book, shelf, items, outputs }: Boot & { host: CompanionApi }) {
  const board = useSyncExternalStore(
    (fn) => controller.subscribe(fn),
    () => controller.board,
  );
  const notes = useSyncExternalStore(
    (fn) => controller.subscribe(fn),
    () => controller.notes,
  );
  const layout = useSyncExternalStore(
    (fn) => controller.subscribe(fn),
    () => controller.layout,
  );
  const [theme, setTheme] = useState<Theme>(info.theme);
  const [notesOpen, setNotesOpen] = useState(false);
  const [prompt, setPrompt] = useState(info.prompt);
  const [sessions, setSessions] = useState<SessionsResponse>(info.sessions);
  const [toast, setToast] = useState<ToastMessage>();
  const toastId = useRef(0);
  const notify = useCallback((text: string, kind: ToastKind = 'info') => setToast({ text, kind, id: ++toastId.current }), []);
  const dismissToast = useCallback(() => setToast(undefined), []);
  const report = (what: string) => (err: unknown) => notify(`Could not ${what}: ${errorText(err)}`, 'error');
  const [settings, setSettings] = useState<Settings>(info.settings);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [update, setUpdate] = useState<UpdateStatus>();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [chooserOpen, setChooserOpen] = useState(false);
  const [newBoardRequest, setNewBoardRequest] = useState(0);
  const [mode, setModeState] = useState<Mode>(info.mode);
  const [focusRequest, setFocusRequest] = useState(0);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const tabScope = useRef<TabScope>({ tabs: [] });

  const { reviewVoice, reviewing, recording, hasVoice, elapsedMs, voiceMs, input, toggleReviewVoice, toggleRecording, discardVoice } = useVoice({
    host,
    book,
    controller,
    mode,
    modeRef,
    notify,
  });

  /** Sketch has a mic, and Review mode has one while a review is open. */
  const onMicrophone = mode === 'sketch' ? () => void toggleRecording() : reviewing ? () => void toggleReviewVoice() : undefined;

  /** Switches modes. Write opens the first draft, or a new note when there is none. */
  const changeMode = useCallback(
    (next: Mode) => {
      setModeState(next);
      host.setMode(next);
      if (next !== 'review') void reviewVoice.stop();
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
  /** Opens a draft main named, filing it under `sessionId` when it has no session yet. */
  const showDraft = useCallback(
    async (id: string, sessionId?: string) => {
      if (!book.get(id)) await book.load();
      if (sessionId && book.get(id) && !book.get(id)!.sessionId) book.file(id, sessionId);
      book.select(id);
    },
    [book],
  );
  const openBoard = useCallback(
    (name: string) => {
      changeMode('sketch');
      if (name !== controller.board) void controller.switchTo(name).catch(report('switch boards'));
    },
    [changeMode, controller],
  );

  const sidebar = useSidebar();
  const { briefs, activeBrief, active, switchBrief, openNotes, closeBrief, leaveEnded } = useBriefTabs({
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
  const boardList = useBoards(host, controller, briefs);
  const { send, sendTo, sendNew, openChooser } = useSend({
    host,
    book,
    controller,
    items,
    reviewVoice,
    modeRef,
    activeBrief,
    notify,
    setChooserOpen,
  });
  usePanelKeys({
    tabs: sidebarOrder(briefs),
    activeBrief,
    switchBrief,
    openNotes,
    changeMode,
    onTalk: onMicrophone,
    popoverOpen: settingsOpen || historyOpen || chooserOpen,
    closePopovers: () => {
      setSettingsOpen(false);
      setHistoryOpen(false);
      setChooserOpen(false);
    },
    onEscape: () => {
      // Drafts save as you type, so Escape in Write mode always hides.
      if (modeRef.current === 'write') {
        void Promise.all([book.flush(), shelf.flush()]);
        host.hidePanel();
        return;
      }
      // Unsent decisions stay in memory while the app runs, and reviews save as you go.
      if (modeRef.current === 'review') {
        host.hidePanel();
        return;
      }
      if (controller.api && shouldHideOnEscape(controller.api.getAppState(), document)) host.hidePanel();
    },
  });

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    host.onPrompt(setPrompt);
    host.onSessions(setSessions);
    host.onTheme(setTheme);
    host.onOpenSettings(() => setSettingsOpen(true));
    host.onUpdate(setUpdate);
    void host.getUpdate().then(setUpdate);
    host.onNewBoard(() => {
      changeMode('sketch');
      setNewBoardRequest((n) => n + 1);
    });
    host.onNewNote(({ text, id, sessionId, source, review }) => {
      // A note for no session comes with the Send target cleared, so the Notes tab shows.
      if (!sessionId) leaveEnded();
      // Main looks for an open review on disk, and a review edited a moment ago may not be there yet.
      const kept = review && book.drafts.find((d) => d.sessionId === sessionId && d.review?.path === review.path);
      if (kept) book.select(kept.id);
      else book.create(text, id, sessionId, source, review);
      changeMode(review ? 'review' : 'write');
    });
    host.onOpenDraft(({ id, sessionId }) => void showDraft(id, sessionId).then(() => changeMode(book.get(id)?.review ? 'review' : 'write')));
    // A note from `agent-brief note` joins the list. The open note and the mode stay.
    host.onDraftsChanged(() => void book.load());
    controller.panelVisible = info.panelVisible;
    host.onVisibility((visible) => {
      controller.panelVisible = visible;
      if (!visible) leaveEnded();
      if (!visible) void Promise.all([book.flush(), shelf.flush()]);
    });
  }, [host, controller, book, shelf, changeMode, showDraft, leaveEnded, info.panelVisible]);

  const onReady = useCallback(
    (api: ExcalidrawImperativeAPI) => {
      host.onRequest(async (req) => {
        // Draft saves never block the board's own flush before quitting.
        if (req.op === 'flush') await Promise.all([book.flush(), shelf.flush()]).catch(() => undefined);
        // /sketch shows a board, which brings Sketch mode forward. A tab switch picks its own mode.
        if (req.op === 'show' && !(req.args as { fromSwitch?: boolean }).fromSwitch) changeMode('sketch');
        return controller.reply(req);
      });
      host.ready();
      if (info.testMode) Object.assign(window, { __board: controller, __excalidraw: api, __drafts: book, __templates: shelf });
    },
    [controller, host, book, shelf, changeMode, info.testMode],
  );

  const listBoards = useCallback(() => host.listBoards(), [host]);
  const reviewError = useCallback((message: string) => notify(message, 'error'), [notify]);
  const [reviewProps] = useState(() => ({ host, voice: reviewVoice, onError: reviewError }));

  const sendBar = (
    <SendTo
      sessions={sessions}
      home={info.home}
      open={chooserOpen}
      onOpenChange={openChooser}
      onSend={() => void send()}
      onSendTo={(id) => void sendTo(id)}
      onSendNew={(cwd, via) => void sendNew(cwd, via)}
      loadOptions={() => host.launchOptions()}
      chooseFolder={() => host.chooseFolder()}
      mic={
        onMicrophone && (
          <Mic
            recording={recording}
            hasVoice={hasVoice}
            reviewing={reviewing}
            onMicrophone={onMicrophone}
            onDiscard={reviewing ? undefined : () => void discardVoice()}
          />
        )
      }
    />
  );
  /** A Write draft carries its own Send in its footer. Review mode keeps the composer, with the mic while a review is open. */
  const inlineSend = mode === 'write';

  return (
    <div className="panel">
      <SessionSidebar
        briefs={briefs}
        activeId={activeBrief}
        home={info.home}
        sidebar={sidebar}
        onNotes={openNotes}
        onSwitch={switchBrief}
        onClose={closeBrief}
        onFocus={(id) => void host.focusSession(id)}
        contents={{
          boards: boardList.boards,
          book,
          board,
          mode,
          onOpenBoard: openBoard,
          onNotes: () => changeMode('write'),
        }}
      />
      <div className="work">
        <header className="strip">
          <div className="lead">
            <button
              className="ghost icon-button"
              title={sidebar.open ? 'Hide sessions' : 'Show sessions'}
              aria-label={sidebar.open ? 'Hide sessions' : 'Show sessions'}
              aria-pressed={sidebar.open}
              onClick={sidebar.toggle}
              data-testid="sidebar-toggle"
            >
              <SidebarIcon />
            </button>
            <nav className="crumb" aria-label="Where you are">
              <SessionCrumb brief={active} onFocus={(id) => void host.focusSession(id)} />
              {mode === 'sketch' && (
                <>
                  <span className="sep" aria-hidden="true">
                    ›
                  </span>
                  <BoardPicker
                    boards={boardList.boards}
                    onRefresh={boardList.refresh}
                    board={board}
                    sessionId={activeBrief}
                    canAttach={!!active?.isLive}
                    newRequest={newBoardRequest}
                    onSwitch={(name) => void controller.switchTo(name).catch(report('switch boards'))}
                    onCreate={(name, layout) => void controller.createBoard(name, layout).catch(report('create the board'))}
                    onRename={(name) => {
                      const from = controller.board;
                      void controller
                        .renameBoard(name)
                        .then(() => book.renameBoard(from, controller.board))
                        .catch(report('rename the board'));
                    }}
                    onDelete={(name) =>
                      controller
                        .deleteBoard(name)
                        .then(() => book.forgetBoard(name))
                        .catch(report('delete the board'))
                    }
                    onDetach={async (name) => {
                      if (!activeBrief) return;
                      try {
                        await host.detachBoard(activeBrief, name);
                        // The panel stays on a detached board until it switches, so it moves to the session's newest other board.
                        const next = name === controller.board ? fallbackBoard(await host.listBoards(), activeBrief, name) : undefined;
                        if (next) await controller.switchTo(next);
                      } catch (err) {
                        report('detach the board')(err);
                      }
                      boardList.refresh();
                    }}
                  />
                </>
              )}
              {mode === 'write' && <NoteCrumb book={book} />}
            </nav>
          </div>
          {/* Review shows on session tabs, and stays while Review is open so a cleared target can pick a tab again. */}
          <ModeSwitch mode={mode} hasReview={!!activeBrief || mode === 'review'} onChange={changeMode} />
          <TopStrip
            tools={
              <>
                <div className="anchor">
                  <button
                    className="ghost icon-button"
                    title="History"
                    aria-label="History"
                    aria-pressed={historyOpen}
                    onClick={() => setHistoryOpen((o) => !o)}
                    data-testid="history-toggle"
                  >
                    <HistoryIcon />
                  </button>
                  {historyOpen && (
                    <HistoryPopover
                      host={host}
                      onOpen={(id) => {
                        setHistoryOpen(false);
                        void host
                          .restoreHistory(id)
                          .then(async ({ board, draftId }) => {
                            if (board) await controller.switchTo(board);
                            if (!draftId) return changeMode('sketch');
                            await book.load();
                            openDraft(draftId);
                          })
                          .catch(report('open that send'));
                      }}
                      onClose={() => setHistoryOpen(false)}
                    />
                  )}
                </div>
                <div className="anchor">
                  <button
                    className="ghost icon-button"
                    title="Settings"
                    aria-label="Settings"
                    aria-pressed={settingsOpen}
                    onClick={() => setSettingsOpen((o) => !o)}
                    data-testid="settings-toggle"
                  >
                    <GearIcon />
                  </button>
                  {settingsOpen && (
                    <SettingsPopover
                      settings={settings}
                      update={update}
                      onCheckUpdate={() => void host.checkForUpdate().then(setUpdate)}
                      onInstallUpdate={() => void host.installUpdate()}
                      onChange={async (patch) => {
                        // Show toggles at once; the reply corrects them if main refuses.
                        setSettings((s) => ({ ...s, ...patch, hotkey: s.hotkey }));
                        const result = await host.setSettings(patch);
                        setSettings(result.settings);
                        return result.ok ? undefined : result.error;
                      }}
                      onClose={() => setSettingsOpen(false)}
                    />
                  )}
                </div>
              </>
            }
          />
        </header>
        {active && !active.isLive && (
          <ResumeRow
            key={active.sessionId}
            brief={active}
            loadOptions={() => host.launchOptions()}
            onResume={(via) =>
              void host
                .resumeSession(active.sessionId, via)
                .then((r) => notify(r.message, r.ok ? 'info' : 'error'))
                .catch(report('resume the session'))
            }
          />
        )}
        <PromptBanner prompt={prompt} onDismiss={() => setPrompt(undefined)} />
        <main className="body">
          <div className="sheet">
            {mode === 'sketch' && (
              <div className="board-bar" data-testid="board-bar">
                <LayoutSwitch layout={layout} onChange={(l) => void controller.setLayout(l).catch(report('change the layout'))} />
                <PullIn book={book} board={board} onOpen={openDraft} />
                <div className="cluster end">
                  <button
                    className="ghost icon-button"
                    title="Board notes"
                    aria-label="Board notes"
                    aria-pressed={notesOpen}
                    onClick={() => setNotesOpen((o) => !o)}
                    data-testid="notes-toggle"
                  >
                    <NotesIcon />
                  </button>
                </div>
              </div>
            )}
            {/* The canvas stays mounted under Write and Review, so a view switch keeps its scene and undo. */}
            <BoardCanvas controller={controller} scene={scene} theme={theme} active={mode === 'sketch'} onReady={onReady} />
          </div>
          {mode === 'write' && (
            <WriteView
              book={book}
              shelf={shelf}
              listBoards={listBoards}
              focusRequest={focusRequest}
              sessionId={activeBrief}
              tabs={briefs}
              onSend={() => void send()}
              onOpenBoard={openBoard}
              onFiled={(where) => notify(`Moved to ${where}.`)}
              onFilingMenu={dismissToast}
              sendBar={sendBar}
              onCopy={(clip) => host.copyRich(clip).then(() => true, (err) => (report('copy the note')(err), false))}
            />
          )}
          {mode === 'review' && (
            <ReviewMode
              book={book}
              items={items}
              outputs={outputs}
              brief={active}
              home={info.home}
              review={reviewProps}
              onOpenOutput={(sessionId, ref) => void host.openOutput(sessionId, ref).catch(report('open that output'))}
              onDismissOutput={(sessionId, ref) => void host.dismissOutput(sessionId, ref).catch(report('hide that output'))}
              onTrack={(sessionId, on) => void host.setTracking(sessionId, on).catch(report('change item tracking'))}
              onOpenItemOutput={(sessionId, path) => void host.openItemOutput(sessionId, path).catch(report('open that file'))}
              onSend={() => void send()}
            />
          )}
          {mode === 'sketch' && notesOpen && (
            <aside className="notes">
              <header>
                <span>
                  Notes <span className="muted">· {board}</span>
                </span>
                <button
                  className="ghost icon-button small"
                  title="Close notes"
                  aria-label="Close notes"
                  onClick={() => setNotesOpen(false)}
                >
                  <CloseIcon />
                </button>
              </header>
              <textarea
                data-testid="notes"
                placeholder={`Notes for ${board}`}
                value={notes}
                onChange={(e) => controller.setNotes(e.target.value)}
              />
            </aside>
          )}
          <Toast
            toast={toast}
            onDismiss={dismissToast}
            onHistory={() => {
              dismissToast();
              setHistoryOpen(true);
            }}
          />
        </main>
        {!inlineSend && (
          <footer className="composer" data-testid="composer">
            {onMicrophone && (
              <VoiceStrip
                recording={recording}
                reviewing={reviewing}
                elapsedMs={elapsedMs}
                voiceMs={voiceMs}
                hasVoice={hasVoice}
                input={input}
                onDiscard={() => void discardVoice()}
              />
            )}
            {sendBar}
          </footer>
        )}
      </div>
    </div>
  );
}
