import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { SessionsResponse } from '../protocol';
import type { CompanionApi, InitInfo, Mode, Settings, Theme, UpdateStatus } from '../shared/ipc';
import { BoardCanvas } from './BoardCanvas';
import { BoardPicker, LayoutSwitch } from './BoardPicker';
import { BriefTabs } from './BriefTabs';
import { BoardController, parseScene, type LoadedScene } from './controller';
import { DraftBook, onTab } from './drafts';
import { TemplateShelf } from './templates';
import { shouldHideOnEscape } from './escape';
import { HistoryPopover } from './HistoryPopover';
import { CloseIcon, GearIcon, HistoryIcon, NotesIcon } from './Icons';
import { ItemsStore } from './items';
import { ItemsView } from './ItemsView';
import { Mic } from './Mic';
import { OutputsStore } from './outputs';
import { PullIn } from './PullIn';
import { ResumeRow } from './ResumeRow';
import { SendTo } from './SendTo';
import { SettingsPopover } from './SettingsPopover';
import { Toast, type ToastKind, type ToastMessage } from './Toast';
import { PromptBanner, TopStrip } from './TopStrip';
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

/** Sketch, Write or Items, at the left of the strip. Items needs a session tab. */
function ModeSwitch(props: { mode: Mode; hasItems: boolean; onChange: (mode: Mode) => void }) {
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
    <div className="cluster modes" role="tablist" aria-label="Mode">
      {tab('sketch', 'Sketch', '⌘1')}
      {tab('write', 'Write', '⌘2')}
      {props.hasItems && tab('items', 'Items', '⌘3')}
    </div>
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

  const { reviewVoice, reviewing, recording, hasVoice, elapsedMs, toggleReviewVoice, toggleRecording } = useVoice({
    host,
    book,
    controller,
    mode,
    modeRef,
    notify,
  });

  /** Write mode has no mic except while reviewing a page. */
  const onMicrophone = mode === 'sketch' ? () => void toggleRecording() : reviewing ? () => void toggleReviewVoice() : undefined;

  /** Switches modes. Write opens the first draft, or a new note when there is none. */
  const changeMode = useCallback(
    (next: Mode) => {
      setModeState(next);
      host.setMode(next);
      if (next !== 'write') void reviewVoice.stop();
      if (next === 'sketch') return;
      // Only Sketch has a mic button, so a recording stops here and waits for the next sketch Send.
      if (controller.recorder.recording) void controller.recorder.stop();
      if (next !== 'write') return;
      const { sessionId, tabs } = tabScope.current;
      const open = book.selected;
      if (!open || !onTab(open, sessionId, tabs)) {
        const first = book.firstOnTab(sessionId, tabs);
        if (first) book.select(first.id);
        else book.create('', undefined, sessionId);
      }
      setFocusRequest((n) => n + 1);
    },
    [host, book, controller, reviewVoice],
  );
  const openDraft = useCallback(
    (id: string) => {
      book.select(id);
      changeMode('write');
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

  const { briefs, activeBrief, active, switchBrief, openNotes, closeBrief, leaveEnded } = useBriefTabs({
    host,
    book,
    sessions,
    modeRef,
    tabScope,
    changeMode,
    showDraft,
    report,
  });
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
    tabs: briefs.map((b) => b.sessionId),
    activeBrief,
    switchBrief,
    openNotes,
    changeMode,
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
      // Unsent decisions stay in memory while the app runs.
      if (modeRef.current === 'items') {
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
      changeMode('write');
    });
    host.onOpenDraft(({ id, sessionId }) => void showDraft(id, sessionId).then(() => changeMode('write')));
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

  return (
    <div className="panel">
      <header className="strip">
        {/* Items shows on session tabs, and stays while Items is open so a cleared target can pick a tab again. */}
        <ModeSwitch mode={mode} hasItems={!!activeBrief || mode === 'items'} onChange={changeMode} />
        {mode === 'sketch' && (
          <>
            <BoardPicker
              host={host}
              board={board}
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
            />
            <LayoutSwitch layout={layout} onChange={(l) => void controller.setLayout(l).catch(report('change the layout'))} />
            <PullIn book={book} board={board} onOpen={openDraft} />
          </>
        )}
        <TopStrip
          tools={
            <>
              {mode === 'sketch' && (
                <button
                  className="ghost icon-button"
                  title="Notes"
                  aria-label="Notes"
                  aria-pressed={notesOpen}
                  onClick={() => setNotesOpen((o) => !o)}
                  data-testid="notes-toggle"
                >
                  <NotesIcon />
                </button>
              )}
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
      <BriefTabs
        briefs={briefs}
        activeId={activeBrief}
        home={info.home}
        onNotes={openNotes}
        onSwitch={switchBrief}
        onClose={closeBrief}
        onFocus={(id) => void host.focusSession(id)}
      />
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
        <BoardCanvas controller={controller} scene={scene} theme={theme} active={mode === 'sketch'} onReady={onReady} />
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
            outputs={outputs}
            onOpenOutput={(sessionId, ref) => void host.openOutput(sessionId, ref).catch(report('open that output'))}
            onDismissOutput={(sessionId, ref) => void host.dismissOutput(sessionId, ref).catch(report('hide that output'))}
            review={reviewProps}
          />
        )}
        {mode === 'items' && (
          <ItemsView
            store={items}
            brief={active}
            home={info.home}
            onTrack={(sessionId, on) => void host.setTracking(sessionId, on).catch(report('change item tracking'))}
            onSend={() => void send()}
            onOpenOutput={(sessionId, path) => void host.openItemOutput(sessionId, path).catch(report('open that file'))}
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
      <footer className="composer" data-testid="composer">
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
                elapsedMs={elapsedMs}
                hasVoice={!reviewing && hasVoice}
                onMicrophone={onMicrophone}
                micLabel={reviewing ? 'Talk through the page. Each pin gets what you say after it.' : undefined}
              />
            )
          }
        />
      </footer>
    </div>
  );
}
