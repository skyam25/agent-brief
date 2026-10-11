import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { SessionsResponse } from '../protocol';
import { findSlots } from '../shared/slots';
import type { CompanionApi, InitInfo, Launcher, Mode, Outgoing, SendResult, SessionBriefEntry, Settings, Theme, UpdateStatus } from '../shared/ipc';
import { BoardCanvas } from './BoardCanvas';
import { BoardPicker } from './BoardPicker';
import { BriefTabs } from './BriefTabs';
import { BoardController, parseScene, type LoadedScene } from './controller';
import { DraftBook, type SentRevision } from './drafts';
import { focusFirstSlot } from './SlotArea';
import { TemplateShelf } from './templates';
import { shouldHideOnEscape } from './escape';
import { HistoryPopover } from './HistoryPopover';
import { CloseIcon, GearIcon, HistoryIcon, NotesIcon } from './Icons';
import { PullIn } from './PullIn';
import { SendTo } from './SendTo';
import { SettingsPopover } from './SettingsPopover';
import { Toast, type ToastKind, type ToastMessage } from './Toast';
import { PromptBanner, TopStrip } from './TopStrip';
import { WriteView } from './WriteView';

interface Boot {
  info: InitInfo;
  controller: BoardController;
  scene: LoadedScene;
  book: DraftBook;
  shelf: TemplateShelf;
}

async function boot(host: CompanionApi): Promise<Boot> {
  const info = await host.init();
  const { scene, notes } = await host.loadBoard(info.currentBoard);
  const loaded = parseScene(scene);
  const controller = new BoardController(host, { board: info.currentBoard, notes, scene: loaded });
  const book = new DraftBook(host);
  const shelf = new TemplateShelf(host);
  await Promise.all([book.load(), shelf.load()]);
  // A launch in Write mode opens the draft at the top of the list.
  if (info.mode === 'write' && book.drafts[0]) book.select(book.drafts[0].id);
  return { info, controller, scene: loaded, book, shelf };
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

const MIC_DENIED =
  'Microphone access is off. Turn it on in System Settings > Privacy & Security > Microphone, then try again.';

/** Sketch or Write, at the left of the strip. */
function ModeSwitch(props: { mode: Mode; onChange: (mode: Mode) => void }) {
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
    </div>
  );
}

function Panel({ host, info, controller, scene, book, shelf }: Boot & { host: CompanionApi }) {
  const board = useSyncExternalStore(
    (fn) => controller.subscribe(fn),
    () => controller.board,
  );
  const notes = useSyncExternalStore(
    (fn) => controller.subscribe(fn),
    () => controller.notes,
  );
  const [theme, setTheme] = useState<Theme>(info.theme);
  const [notesOpen, setNotesOpen] = useState(false);
  const [prompt, setPrompt] = useState(info.prompt);
  const [sessions, setSessions] = useState<SessionsResponse>(info.sessions);
  const [briefs, setBriefs] = useState<SessionBriefEntry[]>([]);
  /** An ended session's tab the user opened. It has no target, so it is the active tab only here. */
  const [endedActive, setEndedActive] = useState<string>();
  const [toast, setToast] = useState<ToastMessage>();
  const toastId = useRef(0);
  const notify = useCallback((text: string, kind: ToastKind = 'info') => setToast({ text, kind, id: ++toastId.current }), []);
  const dismissToast = useCallback(() => setToast(undefined), []);
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
  const popoverOpenRef = useRef(false);
  popoverOpenRef.current = settingsOpen || historyOpen || chooserOpen;

  /** Switches modes. Write opens the first draft, or a new note when there is none. */
  const changeMode = useCallback(
    (next: Mode) => {
      setModeState(next);
      host.setMode(next);
      if (next !== 'write') return;
      // Write mode has no mic button, so a recording stops here and waits for the next sketch Send.
      if (controller.recorder.recording) void controller.recorder.stop();
      if (!book.selected) {
        const first = book.drafts.find((d) => d.body.trim() || d.board);
        if (first) book.select(first.id);
        else book.create();
      }
      setFocusRequest((n) => n + 1);
    },
    [host, book, controller],
  );
  const openDraft = useCallback(
    (id: string) => {
      book.select(id);
      changeMode('write');
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

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    host.onPrompt(setPrompt);
    host.onSessions(setSessions);
    void host.listBriefs().then(setBriefs);
    host.onBriefs(setBriefs);
    host.onTheme(setTheme);
    host.onOpenSettings(() => setSettingsOpen(true));
    host.onUpdate(setUpdate);
    void host.getUpdate().then(setUpdate);
    host.onNewBoard(() => {
      changeMode('sketch');
      setNewBoardRequest((n) => n + 1);
    });
    host.onNewNote(({ text, id }) => {
      book.create(text, id);
      changeMode('write');
    });
    host.onOpenDraft((id) => {
      void (async () => {
        if (!book.get(id)) await book.load();
        book.select(id);
        changeMode('write');
      })();
    });
    controller.panelVisible = info.panelVisible;
    host.onVisibility((visible) => {
      controller.panelVisible = visible;
      if (!visible) setEndedActive(undefined);
      if (!visible) void Promise.all([book.flush(), shelf.flush()]);
    });

    // Escape hides the panel unless something on it wants the key first.
    const onKey = (e: KeyboardEvent) => {
      // A shortcut field in Settings takes every key while it records.
      if (document.querySelector('.key-chip.recording')) return;
      if (e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'Tab' || /^[1-9]$/.test(e.key))) {
        const { briefs: tabs, activeBrief: active, switchBrief: open } = tabKeys.current;
        if (tabs.length === 0) return;
        e.preventDefault();
        // With no tab active, ⌃Tab starts at the first and ⌃⇧Tab at the last.
        const at = tabs.findIndex((b) => b.sessionId === active);
        const from = at >= 0 ? at : e.shiftKey ? 0 : -1;
        const next = e.key === 'Tab' ? tabs[(from + (e.shiftKey ? -1 : 1) + tabs.length) % tabs.length] : tabs[Number(e.key) - 1];
        if (next && next.sessionId !== active) open(next.sessionId);
        return;
      }
      if (e.metaKey && !e.shiftKey && !e.altKey && (e.key === '1' || e.key === '2')) {
        e.preventDefault();
        changeMode(e.key === '1' ? 'sketch' : 'write');
        return;
      }
      if (e.key !== 'Escape') return;
      // A menu inside the editor, such as the template picker, closes first.
      if (document.querySelector('[data-escape-owner]')) return;
      if (popoverOpenRef.current) {
        setSettingsOpen(false);
        setHistoryOpen(false);
        setChooserOpen(false);
        e.stopPropagation();
        return;
      }
      // Drafts save as you type, so Escape in Write mode always hides.
      if (modeRef.current === 'write') {
        void Promise.all([book.flush(), shelf.flush()]);
        host.hidePanel();
        return;
      }
      if (controller.api && shouldHideOnEscape(controller.api.getAppState(), document)) host.hidePanel();
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [host, controller, book, shelf, changeMode, info.panelVisible]);

  const onReady = useCallback(
    (api: ExcalidrawImperativeAPI) => {
      host.onRequest(async (req) => {
        // Draft saves never block the board's own flush before quitting.
        if (req.op === 'flush') await Promise.all([book.flush(), shelf.flush()]).catch(() => undefined);
        // Only /sketch asks to show a board, so it also brings Sketch mode forward.
        if (req.op === 'show') changeMode('sketch');
        return controller.reply(req);
      });
      host.ready();
      if (info.testMode) Object.assign(window, { __board: controller, __excalidraw: api, __drafts: book, __templates: shelf });
    },
    [controller, host, book, shelf, changeMode, info.testMode],
  );

  const report = (what: string) => (err: unknown) => notify(`Could not ${what}: ${errorText(err)}`, 'error');

  // The active tab is the Send target's brief, or an ended session's brief the user opened.
  const target = sessions.targetSessionId;
  const activeBrief = briefs.some((b) => b.sessionId === target) ? target : briefs.some((b) => b.sessionId === endedActive) ? endedActive : undefined;
  const switchBrief = (sessionId: string) => {
    const brief = briefs.find((b) => b.sessionId === sessionId);
    setEndedActive(brief && !brief.isLive ? sessionId : undefined);
    void host.switchBrief(sessionId).catch(report('open that brief'));
  };
  const closeBrief = (sessionId: string) => {
    if (endedActive === sessionId) setEndedActive(undefined);
    void host.forgetBrief(sessionId).catch(report('close the tab'));
  };
  // ⌃1–⌃9 and ⌃Tab read these from the key handler, which is set up once.
  const tabKeys = useRef({ briefs, activeBrief, switchBrief });
  tabKeys.current = { briefs, activeBrief, switchBrief };
  const listBoards = useCallback(() => host.listBoards(), [host]);

  /** The text whose empty slots were already pointed out, so a second Send goes through. */
  const slotsWarned = useRef<string>(undefined);
  const checkSlots = (text: string): string | undefined => {
    const count = findSlots(text).length;
    if (!count || slotsWarned.current === text) return undefined;
    slotsWarned.current = text;
    return `${count === 1 ? '1 empty slot' : `${count} empty slots`}. Send again to send anyway.`;
  };

  /**
   * What Send hands over. Sketch mode sends the board with any draft pulled in.
   * Write mode sends the open draft with the board it carries, if any.
   */
  const outgoing = async (): Promise<{ payload: Outgoing; clearsBoard: boolean; sent?: SentRevision } | string> => {
    if (modeRef.current === 'sketch') {
      const linked = book.linkedTo(controller.board);
      const unfilled = linked && checkSlots(linked.body);
      if (unfilled) return unfilled;
      await book.flush();
      const payload = await controller.payload();
      if (!linked) return { payload, clearsBoard: true };
      return { payload: { ...payload, text: linked.body, draftId: linked.id }, clearsBoard: true, sent: { body: linked.body, board: linked.board } };
    }
    const draft = book.selected;
    if (!draft || (!draft.body.trim() && !draft.board)) return 'Write something first.';
    const unfilled = checkSlots(draft.body);
    if (unfilled) {
      focusFirstSlot('draft-body');
      return unfilled;
    }
    await book.flush();
    const sent = { body: draft.body, board: draft.board };
    if (!draft.board) return { payload: { text: draft.body, draftId: draft.id }, clearsBoard: false, sent };
    if (draft.board !== controller.board) await controller.switchTo(draft.board);
    return { payload: { ...(await controller.payload()), text: draft.body, draftId: draft.id }, clearsBoard: true, sent };
  };

  /** True from the press of Send until main answers, so a second press cannot send twice. */
  const sending = useRef(false);

  /** Builds the payload, hands it over, and hides the panel once it went out. */
  const deliver = async (handOff: (payload: Outgoing) => Promise<SendResult>) => {
    if (sending.current) return;
    sending.current = true;
    setChooserOpen(false);
    notify('Preparing…', 'progress');
    try {
      const out = await outgoing();
      if (typeof out === 'string') {
        notify(out);
        return;
      }
      const result = await handOff(out.payload);
      notify(result.message, result.ok ? 'sent' : 'error');
      if (result.ok) {
        if (out.clearsBoard) controller.clearBoard();
        if (out.payload.draftId && out.sent) book.consume(out.payload.draftId, out.sent);
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
  const sendNew = (cwd: string, via: Launcher) => deliver((p) => host.sendNew(p, { cwd, via }));
  /** An empty note says so before any session is picked. */
  const openChooser = (open: boolean) => {
    const draft = book.selected;
    if (open && modeRef.current === 'write' && (!draft || (!draft.body.trim() && !draft.board))) {
      notify('Write something first.');
      return;
    }
    setChooserOpen(open);
  };

  const recording = useSyncExternalStore(
    (fn) => controller.recorder.subscribe(fn),
    () => controller.recorder.recording,
  );
  const hasVoice = useSyncExternalStore(
    (fn) => controller.recorder.subscribe(fn),
    () => controller.recorder.segments.length > 0,
  );
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [recording]);
  const elapsedMs = recording && controller.recorder.since !== undefined ? Math.max(0, now - controller.recorder.since) : 0;

  // The mic button records voice for the next Send. It asks macOS first and says why when refused.
  const toggleRecording = async () => {
    if (controller.recorder.recording) {
      await controller.recorder.stop();
      notify(`Recorded ${controller.recorder.segments.length} clip(s). Send includes them.`);
      return;
    }
    const access = await host.requestMicrophone();
    if (!access.granted) {
      notify(MIC_DENIED, 'error');
      return;
    }
    // Leaving Sketch while macOS asked about the mic cancels the start.
    if (modeRef.current !== 'sketch') return;
    try {
      await controller.recorder.start();
      if (modeRef.current !== 'sketch') {
        await controller.recorder.stop();
        return;
      }
      notify('Recording. Talk while you sketch.');
    } catch (err) {
      notify(`Could not start the microphone: ${(err as Error).message}`, 'error');
    }
  };

  return (
    <div className="panel">
      <header className="strip">
        <ModeSwitch mode={mode} onChange={changeMode} />
        {mode === 'sketch' && (
          <>
            <BoardPicker
              host={host}
              board={board}
              newRequest={newBoardRequest}
              onSwitch={(name) => void controller.switchTo(name).catch(report('switch boards'))}
              onCreate={(name) => void controller.createBoard(name).catch(report('create the board'))}
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
            <PullIn book={book} board={board} onOpen={openDraft} />
          </>
        )}
        <TopStrip
          tools={
            <>
              {mode === 'sketch' && (
                <>
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
                </>
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
          sendControl={
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
            />
          }
          recording={recording}
          elapsedMs={elapsedMs}
          hasVoice={hasVoice}
          onMicrophone={mode === 'sketch' ? () => void toggleRecording() : undefined}
        />
      </header>
      <BriefTabs
        briefs={briefs}
        activeId={activeBrief}
        home={info.home}
        onSwitch={switchBrief}
        onClose={closeBrief}
        onFocus={(id) => void host.focusSession(id)}
      />
      <PromptBanner prompt={prompt} onDismiss={() => setPrompt(undefined)} />
      <main className="body">
        <BoardCanvas controller={controller} scene={scene} theme={theme} onReady={onReady} />
        {mode === 'write' && (
          <WriteView
            book={book}
            shelf={shelf}
            listBoards={listBoards}
            focusRequest={focusRequest}
            onSend={() => void send()}
            onOpenBoard={openBoard}
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
    </div>
  );
}
