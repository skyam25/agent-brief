import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { CompanionApi, InitInfo, ItemReference, Mode, SessionBriefEntry, Settings, Theme, UpdateStatus } from '../shared/ipc';
import { BoardCanvas, openBoardSearch } from './BoardCanvas';
import { workspaceComments } from './workspace-boards';
import { BoardCommentsStore } from './board-comments';
import { CommentColumn, CommentToggle, useCommentKeys } from './BoardComments';
import { decisionsClaim, subscribeDecisions } from './decisions-send';
import { BoardPicker, LayoutSwitch } from './BoardPicker';
import { fallbackBoard } from './boardScope';
import { BoardController, parseScene, type LoadedScene } from './controller';
import { draftTitle } from '../shared/drafts';
import { draftName } from './DraftList';
import { DraftBook } from './drafts';
import { openFind } from './editor/RichEditor';
import { openPageFind } from './ReviewView';
import { TemplateShelf } from './templates';
import { shouldHideOnEscape } from './escape';
import { HistoryPopover } from './HistoryPopover';
import { CloseIcon, GearIcon, HistoryIcon, NotesIcon, SidebarIcon } from './Icons';
import { useStore } from './hooks';
import { InitiativesStore } from './initiatives';
import { InitiativeView } from './InitiativeView';
import { ItemsStore } from './items';
import { Mic, VoiceStrip } from './Mic';
import { OutputsStore } from './outputs';
import { PullIn } from './PullIn';
import { ResumeRow } from './ResumeRow';
import { ReviewMode } from './ReviewMode';
import { SessionDot, SessionSidebar, sessionState, sidebarOrder, useSidebar } from './SessionSidebar';
import { SendTo } from './SendTo';
import { SettingsPopover } from './SettingsPopover';
import { Toast, type ToastKind, type ToastMessage } from './Toast';
import { PromptBanner, TopStrip } from './TopStrip';
import { useBoards } from './useBoards';
import { usePanelKeys } from './usePanelKeys';
import { useSend } from './useSend';
import { useWorkspace } from './useWorkspace';
import { WriteView } from './WriteView';

interface Boot {
  info: InitInfo;
  controller: BoardController;
  scene: LoadedScene;
  book: DraftBook;
  shelf: TemplateShelf;
  items: ItemsStore;
  outputs: OutputsStore;
  initiatives: InitiativesStore;
  comments: BoardCommentsStore;
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
  const initiatives = new InitiativesStore(host);
  const comments = new BoardCommentsStore(host);
  await Promise.all([book.load(), shelf.load(), comments.load(), workspaceComments.connect(host)]);
  // A launch in Write mode opens on the Notes tab, at the top of its list.
  const first = book.drafts.find((d) => !d.sessionId);
  if (info.mode === 'write' && first) book.select(first.id);
  return { info, controller, scene: loaded, book, shelf, items, outputs, initiatives, comments };
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

/** The view tabs, Sketch, Write, Review and Initiative, in the middle of the strip. Review needs a session tab. */
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
      {tab('initiative', 'Initiative', '⌘4')}
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
  const state = sessionState(b).tip;
  const label = (
    <>
      <SessionDot brief={b} />
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

function Panel({ host, info, controller, scene, book, shelf, items, outputs, initiatives, comments }: Boot & { host: CompanionApi }) {
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
  const [toast, setToast] = useState<ToastMessage>();
  const toastId = useRef(0);
  const notify = useCallback((text: string, kind: ToastKind = 'info') => setToast({ text, kind, id: ++toastId.current }), []);
  const dismissToast = useCallback(() => setToast(undefined), []);
  const report = (what: string) => (err: unknown) => notify(`Could not ${what}: ${errorText(err)}`, 'error');
  const copyReference = (ref: ItemReference) =>
    void host.copyReference(ref).then(() => notify('Copied. Paste it into any Claude Code session.'), report('copy the reference'));
  const [settings, setSettings] = useState<Settings>(info.settings);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [update, setUpdate] = useState<UpdateStatus>();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [chooserOpen, setChooserOpen] = useState(false);
  const commentError = useSyncExternalStore((fn) => comments.subscribe(fn), () => comments.saveError);
  useEffect(() => {
    if (commentError) notify(`Could not save board comments: ${commentError}`, 'error');
  }, [commentError, notify]);
  const {
    sessions, mode, modeRef, focusRequest, newBoardRequest, changeMode, openDraft, openBoard, onReady,
    briefs, activeBrief, active, switchBrief, openNotes, closeBrief, reviewVoice,
    reviewing, commenting, recording, hasVoice, since, voiceMs, input, discardVoice, onMicrophone,
  } = useWorkspace({ host, info, controller, book, shelf, comments, board, notify, report });
  const micStarting = useSyncExternalStore((fn) => reviewVoice.subscribe(fn), () => reviewVoice.starting) && reviewing;
  useCommentKeys(comments, mode === 'sketch');
  const sidebar = useSidebar();
  const boardList = useBoards(host, controller, briefs);
  const { send, sendTo, sendNew, copyPrompt, openChooser, sendText } = useSend({
    host,
    book,
    controller,
    comments,
    items,
    reviewVoice,
    modeRef,
    activeBrief,
    targetSessionId: sessions.targetSessionId,
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
      // Unsent decisions stay in memory while the app runs, reviews save as you go, and briefs save on Save.
      if (modeRef.current === 'review' || modeRef.current === 'initiative') {
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
    const subscriptions = [
      host.onPrompt(setPrompt), host.onTheme(setTheme),
      host.onOpenSettings(() => setSettingsOpen(true)), host.onUpdate(setUpdate),
      // Edit › Find opens the find of the view on show.
      host.onFind(() => {
        if (modeRef.current === 'sketch' && controller.api) openBoardSearch(controller.api);
        if (modeRef.current === 'write') openFind('draft-body');
        if (modeRef.current === 'review') openPageFind();
      }),
    ];
    void host.getUpdate().then(setUpdate);
    // A file with no page opens its Feedback view in Review, as /open asked.
    subscriptions.push(
      host.onOpenFeedbackView(({ sessionId, path }) => {
        outputs.askFeedback(sessionId, path);
        changeMode('review');
      }),
    );
    return () => {
      for (const off of subscriptions) if (typeof off === 'function') off();
    };
  }, [host]);

  const listBoards = useCallback(() => host.listBoards(), [host]);
  const reviewError = useCallback((message: string) => notify(message, 'error'), [notify]);
  const [reviewProps] = useState(() => ({ host, voice: reviewVoice, onError: reviewError }));

  // A Feedback view on show turns Send into its Send decisions.
  const decisions = useSyncExternalStore(subscribeDecisions, decisionsClaim);
  const holder = mode === 'sketch' ? boardList.boards.find((b) => b.name === board)?.sessionId : book.selected?.sessionId;
  const sendBar = (
    <SendTo
      sessions={sessions}
      home={info.home}
      open={chooserOpen}
      onOpenChange={openChooser}
      onSend={() => void send()}
      onSendTo={(id) => void sendTo(id)}
      onSendNew={(cwd, via) => void sendNew(cwd, via)}
      onCopyPrompt={(cwd) => void copyPrompt(cwd)}
      holder={holder}
      holderCwd={briefs.find((b) => b.sessionId === holder)?.cwd}
      holds={mode === 'sketch' ? 'board' : 'note'}
      loadOptions={() => host.launchOptions()}
      loadPlaces={() => host.sessionPlaces()}
      chooseFolder={() => host.chooseFolder()}
      decisions={mode === 'review' ? decisions : undefined}
      mic={
        onMicrophone && (
          <Mic
            recording={recording}
            board={mode === 'sketch'}
            note={mode === 'write'}
            onMicrophone={onMicrophone}
            onDiscard={reviewing ? undefined : () => void discardVoice()}
          />
        )
      }
    />
  );
  /** A Write draft carries its own Send in its footer. Review mode keeps the composer, with the mic while a review is open. */
  const inlineSend = mode === 'write';

  /** The panel stays on a board that leaves the active container, so it moves to the container's newest other board. */
  const leaveBoards = async (names: string[]) => {
    if (!names.includes(controller.board)) return;
    const next = fallbackBoard(await host.listBoards(), activeBrief, names);
    if (next) await controller.switchTo(next);
  };
  const renameBoard = (from: string, to: string) =>
    void comments.flush()
      .then(() => controller.renameBoard(to, from))
      .then((name) => { book.renameBoard(from, name); comments.rename(from, name); })
      .catch(report('rename the board'))
      .finally(boardList.refresh);
  const deleteBoards = async (names: string[]) => {
    try {
      await leaveBoards(names);
      for (const name of names) {
        await comments.flush();
        await controller.deleteBoard(name);
        book.forgetBoard(name);
        comments.forget(name);
      }
    } catch (err) {
      report('delete the board')(err);
    }
    boardList.refresh();
  };
  /** Files boards under a session, or detaches them from the active one to Unfiled. */
  const fileBoards = async (names: string[], sessionId: string | undefined) => {
    try {
      if (sessionId) await host.moveBoards(names, sessionId);
      else if (activeBrief) for (const name of names) await host.detachBoard(activeBrief, name);
      await leaveBoards(names);
    } catch (err) {
      report('move the board')(err);
    }
    boardList.refresh();
  };

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
          actions: {
            rename: renameBoard,
            copy: (name) => copyReference({ kind: 'board', name }),
            remove: (names) => void deleteBoards(names),
            file: (names, sessionId) => void fileBoards(names, sessionId),
          },
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
                    listed={sidebar.open}
                    newRequest={newBoardRequest}
                    onSwitch={(name) => void controller.switchTo(name).catch(report('switch boards'))}
                    onCreate={(name, layout) => void controller.createBoard(name, layout).catch(report('create the board'))}
                    onRename={(name) => renameBoard(controller.board, name)}
                    onDelete={(name) => deleteBoards([name])}
                    onDetach={(name) => fileBoards([name], undefined)}
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
                      onUpdateNow={() => void host.updateNow().then(setUpdate)}
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
                <CommentToggle comments={comments} />
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
            <BoardCanvas controller={controller} scene={scene} theme={theme} active={mode === 'sketch'} onReady={onReady} comments={comments} board={board} />
          </div>
          {commenting && (
            <CommentColumn
              comments={comments}
              board={board}
              voice={reviewVoice}
              onSendKeys={(e) => {
                if (e.key === 'Enter' && e.metaKey) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
          )}
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
              voice={reviewVoice}
              talking={recording}
              onCopy={(clip) => host.copyRich(clip).then(() => true, (err) => (report('copy the note')(err), false))}
              onCopyReference={(d) =>
                copyReference(
                  (d.source ?? d.outline) && d.sessionId
                    ? { kind: 'output', sessionId: d.sessionId, ref: (d.source ?? d.outline)!.path, title: draftName(d) }
                    : { kind: 'note', id: d.id, title: draftName(d) },
                )
              }
              onOpenElsewhere={async (d) => {
                if (d.sessionId && briefs.some((b) => b.sessionId === d.sessionId)) return switchBrief(d.sessionId, d.id);
                openNotes();
                book.select(d.id);
              }}
              outlineHost={host}
              onSendText={(sessionId, build) => void sendText(sessionId, build)}
              onError={reviewError}
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
              onSendFeedback={(sessionId, build) => void sendText(sessionId, build)}
              onCopyReference={copyReference}
            />
          )}
          {mode === 'initiative' && (
            <InitiativeView
              store={initiatives}
              briefs={briefs}
              home={info.home}
              onDiscover={() => {
                // A running session on show takes the prompt at once. Otherwise Send's picker asks which one.
                if (active?.isLive) void send();
                else openChooser(true);
              }}
              chooseFolder={() => host.chooseFolder()}
              onReveal={(path) => void host.revealPath(path).catch(report('show that in Finder'))}
              onCopyReference={(i) => copyReference({ kind: 'initiative', id: i.id, title: i.title })}
              onError={reviewError}
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
                starting={micStarting}
                since={since}
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
