import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { SessionsResponse } from '../protocol';
import { draftImages } from '../shared/drafts';
import { findSlots } from '../shared/slots';
import type { CompanionApi, Decision, Draft, InitInfo, Launcher, Mode, Outgoing, SendResult, SessionBriefEntry, Settings, Theme, UpdateStatus } from '../shared/ipc';
import { BoardCanvas } from './BoardCanvas';
import { BoardPicker } from './BoardPicker';
import { BriefTabs } from './BriefTabs';
import { BoardController, parseScene, type LoadedScene } from './controller';
import { DraftBook, onTab, type SentRevision } from './drafts';
import { focusFirstSlot } from './editor/RichEditor';
import { TemplateShelf } from './templates';
import { shouldHideOnEscape } from './escape';
import { HistoryPopover } from './HistoryPopover';
import { CloseIcon, GearIcon, HistoryIcon, NotesIcon } from './Icons';
import { ItemsStore } from './items';
import { ItemsView } from './ItemsView';
import { PullIn } from './PullIn';
import { ResumeRow } from './ResumeRow';
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
  items: ItemsStore;
}

async function boot(host: CompanionApi): Promise<Boot> {
  const info = await host.init();
  const { scene, notes } = await host.loadBoard(info.currentBoard);
  const loaded = parseScene(scene);
  const controller = new BoardController(host, { board: info.currentBoard, notes, scene: loaded });
  const book = new DraftBook(host);
  const shelf = new TemplateShelf(host);
  const items = new ItemsStore(host);
  await Promise.all([book.load(), shelf.load()]);
  // A launch in Write mode opens on the Notes tab, at the top of its list.
  const first = book.drafts.find((d) => !d.sessionId);
  if (info.mode === 'write' && first) book.select(first.id);
  return { info, controller, scene: loaded, book, shelf, items };
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

/** The decisions an Items Send delivers, so success can clear them. */
interface Decided {
  sessionId: string;
  decisions: Decision[];
}

const MIC_DENIED =
  'Microphone access is off. Turn it on in System Settings > Privacy & Security > Microphone, then try again.';

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

function Panel({ host, info, controller, scene, book, shelf, items }: Boot & { host: CompanionApi }) {
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
  /** The tab on show: its session, or undefined for Notes, with every session tab's id. */
  const tabScope = useRef<{ sessionId?: string; tabs: string[] }>({ tabs: [] });
  const popoverOpenRef = useRef(false);
  popoverOpenRef.current = settingsOpen || historyOpen || chooserOpen;

  /** Switches modes. Write opens the first draft, or a new note when there is none. */
  const changeMode = useCallback(
    (next: Mode) => {
      setModeState(next);
      host.setMode(next);
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
    [host, book, controller],
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
    host.onNewNote(({ text, id, sessionId }) => {
      // A note for no session comes with the Send target cleared, so the Notes tab shows.
      if (!sessionId) setEndedActive(undefined);
      book.create(text, id, sessionId);
      changeMode('write');
    });
    host.onOpenDraft(({ id, sessionId }) => void showDraft(id, sessionId).then(() => changeMode('write')));
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
        const { briefs: tabs, activeBrief: active, switchBrief: open, openNotes } = tabKeys.current;
        if (tabs.length === 0) return;
        e.preventDefault();
        // Notes is the first tab, then each session's.
        const order = [undefined, ...tabs.map((b) => b.sessionId)];
        const at = order.indexOf(active);
        const index = e.key === 'Tab' ? (at + (e.shiftKey ? -1 : 1) + order.length) % order.length : Number(e.key) - 1;
        if (index >= order.length || index === at) return;
        const next = order[index];
        if (next) open(next);
        else openNotes();
        return;
      }
      const byKey: Record<string, Mode> = { '1': 'sketch', '2': 'write', '3': 'items' };
      if (e.metaKey && !e.shiftKey && !e.altKey && byKey[e.key]) {
        e.preventDefault();
        // Items needs a session tab.
        if (byKey[e.key] === 'items' && !tabKeys.current.activeBrief) return;
        changeMode(byKey[e.key]!);
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
      // Unsent decisions stay in memory while the app runs.
      if (modeRef.current === 'items') {
        host.hidePanel();
        return;
      }
      if (controller.api && shouldHideOnEscape(controller.api.getAppState(), document)) host.hidePanel();
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [host, controller, book, shelf, changeMode, showDraft, info.panelVisible]);

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

  const report = (what: string) => (err: unknown) => notify(`Could not ${what}: ${errorText(err)}`, 'error');

  // The active tab is the Send target's brief, or an ended session's brief the user opened.
  const target = sessions.targetSessionId;
  const activeBrief = briefs.some((b) => b.sessionId === target) ? target : briefs.some((b) => b.sessionId === endedActive) ? endedActive : undefined;
  const switchBrief = (sessionId: string) => {
    const brief = briefs.find((b) => b.sessionId === sessionId);
    setEndedActive(brief && !brief.isLive ? sessionId : undefined);
    void host
      .switchBrief(sessionId)
      .then(async (opened) => {
        if ('draftId' in opened) await showDraft(opened.draftId);
        // Items stays open across a switch; otherwise the tab shows what it opened.
        if (modeRef.current !== 'items') changeMode('draftId' in opened ? 'write' : 'sketch');
      })
      .catch(report('open that brief'));
  };
  /** The Notes tab: no Send target and no session. Items needs a session, so it falls back to Write. */
  const openNotes = () => {
    setEndedActive(undefined);
    if (modeRef.current === 'items') changeMode('write');
    if (target) void host.setTarget(undefined).catch(report('leave the session'));
  };
  const closeBrief = (sessionId: string) => {
    if (endedActive === sessionId) setEndedActive(undefined);
    void host.forgetBrief(sessionId).catch(report('close the tab'));
  };
  // ⌃1–⌃9 and ⌃Tab read these from the key handler, which is set up once.
  const tabKeys = useRef({ briefs, activeBrief, switchBrief, openNotes });
  tabKeys.current = { briefs, activeBrief, switchBrief, openNotes };
  tabScope.current = { sessionId: activeBrief, tabs: briefs.map((b) => b.sessionId) };
  const active = briefs.find((b) => b.sessionId === activeBrief);

  // A tab switch leaves the open draft when it belongs to another tab, and opens one that belongs here.
  useEffect(() => {
    const open = book.selected;
    if (!open || onTab(open, activeBrief, tabScope.current.tabs)) return;
    book.select(book.firstOnTab(activeBrief, tabScope.current.tabs)?.id);
  }, [activeBrief, book]);

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
  const outgoing = async (): Promise<{ payload: Outgoing; clearsBoard: boolean; sent?: SentRevision; decided?: Decided } | string> => {
    if (modeRef.current === 'items') {
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
      const payload = await controller.payload();
      if (!linked) return { payload, clearsBoard: true };
      return {
        payload: { ...payload, text: linked.body, draftId: linked.id, ...withImages(linked) },
        clearsBoard: true,
        sent: { body: linked.body, board: linked.board },
      };
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
    if (!draft.board) return { payload: { text: draft.body, draftId: draft.id, ...withImages(draft) }, clearsBoard: false, sent };
    if (draft.board !== controller.board) await controller.switchTo(draft.board);
    return { payload: { ...(await controller.payload()), text: draft.body, draftId: draft.id, ...withImages(draft) }, clearsBoard: true, sent };
  };

  /** The pictures a draft's body references, as a payload field. Absent when there are none. */
  const withImages = (draft: Draft) => {
    const images = draftImages(draft);
    return images.length ? { images } : {};
  };

  /** Why Send in Items mode has nothing to send, if it has not. */
  const itemsBlocker = (): string | undefined => {
    if (!activeBrief) return "Open a session's items first.";
    if (items.decisions(activeBrief).length === 0) return 'Decide something first.';
    return undefined;
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
  const sendNew = (cwd: string, via: Launcher) => deliver((p) => host.sendNew(p, { cwd, via }));
  /** An empty note says so before any session is picked. */
  const openChooser = (open: boolean) => {
    const draft = book.selected;
    if (open && modeRef.current === 'write' && (!draft || (!draft.body.trim() && !draft.board))) {
      notify('Write something first.');
      return;
    }
    const blocked = open && modeRef.current === 'items' ? itemsBlocker() : undefined;
    if (blocked) {
      notify(blocked);
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
        {/* Items shows on session tabs, and stays while Items is open so a cleared target can pick a tab again. */}
        <ModeSwitch mode={mode} hasItems={!!activeBrief || mode === 'items'} onChange={changeMode} />
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
        <BoardCanvas controller={controller} scene={scene} theme={theme} onReady={onReady} />
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
    </div>
  );
}
