import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { SessionsResponse } from '../protocol';
import type { CompanionApi, InitInfo, IpadStatus, Launcher, SendResult, Settings, Theme } from '../shared/ipc';
import { BoardCanvas } from './BoardCanvas';
import { BoardPicker } from './BoardPicker';
import { BoardController, parseScene, type LoadedScene } from './controller';
import { shouldHideOnEscape } from './escape';
import { HistoryPopover } from './HistoryPopover';
import { GearIcon } from './Icons';
import { IpadSheet } from './IpadSheet';
import { SendTo } from './SendTo';
import { SettingsPopover } from './SettingsPopover';
import { TopStrip } from './TopStrip';

interface Boot {
  info: InitInfo;
  controller: BoardController;
  scene: LoadedScene;
}

async function boot(host: CompanionApi): Promise<Boot> {
  const info = await host.init();
  const { scene, notes } = await host.loadBoard(info.currentBoard);
  const loaded = parseScene(scene);
  const controller = new BoardController(host, { board: info.currentBoard, notes, scene: loaded });
  return { info, controller, scene: loaded };
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

function Panel({ host, info, controller, scene }: Boot & { host: CompanionApi }) {
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
  const [status, setStatus] = useState<string>();
  const [settings, setSettings] = useState<Settings>(info.settings);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [chooserOpen, setChooserOpen] = useState(false);
  const [newBoardRequest, setNewBoardRequest] = useState(0);
  const [ipad, setIpad] = useState<IpadStatus>();
  const [ipadOpen, setIpadOpen] = useState(false);
  const popoverOpenRef = useRef(false);
  popoverOpenRef.current = settingsOpen || historyOpen || chooserOpen;

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    host.onPrompt(setPrompt);
    host.onSessions(setSessions);
    host.onTheme(setTheme);
    host.onOpenSettings(() => setSettingsOpen(true));
    host.onNewBoard(() => setNewBoardRequest((n) => n + 1));
    controller.panelVisible = info.panelVisible;
    host.onVisibility((visible) => (controller.panelVisible = visible));
    host.onRemoteElements?.((name, elements) => controller.applyRemote(name, elements));
    host.onIpad((status, show) => {
      setIpad(status);
      if (show) setIpadOpen(true);
    });

    // Escape hides the panel unless something on it wants the key first.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (popoverOpenRef.current) {
        setSettingsOpen(false);
        setHistoryOpen(false);
        setChooserOpen(false);
        e.stopPropagation();
        return;
      }
      if (controller.api && shouldHideOnEscape(controller.api.getAppState(), document)) host.hidePanel();
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [host, controller, info.panelVisible]);

  const onReady = useCallback(
    (api: ExcalidrawImperativeAPI) => {
      host.onRequest((req) => controller.reply(req));
      host.ready();
      if (info.testMode) Object.assign(window, { __board: controller, __excalidraw: api });
    },
    [controller, host, info.testMode],
  );

  const report = (what: string) => (err: unknown) => setStatus(`Could not ${what}: ${errorText(err)}`);

  /** Builds the payload, hands it over, and hides the panel once it went out. */
  const deliver = async (handOff: (payload: Awaited<ReturnType<typeof controller.payload>>) => Promise<SendResult>) => {
    setChooserOpen(false);
    setStatus('Preparing…');
    try {
      const result = await handOff(await controller.payload());
      setStatus(result.message);
      if (result.ok) {
        controller.clearBoard();
        host.hidePanel();
      }
    } catch (err) {
      setStatus(`Send failed: ${(err as Error).message}`);
    }
  };
  const send = () => deliver((p) => host.send(p));
  const sendTo = async (sessionId: string) => {
    await host.setTarget(sessionId);
    await deliver((p) => host.send(p));
  };
  const sendNew = (cwd: string, via: Launcher) => deliver((p) => host.sendNew(p, { cwd, via }));

  const recording = useSyncExternalStore(
    (fn) => controller.recorder.subscribe(fn),
    () => controller.recorder.recording,
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
      setStatus(`Recorded ${controller.recorder.segments.length} clip(s). Send includes them.`);
      return;
    }
    const access = await host.requestMicrophone();
    if (!access.granted) {
      setStatus(MIC_DENIED);
      return;
    }
    try {
      await controller.recorder.start();
      setStatus('Recording. Talk while you sketch.');
    } catch (err) {
      setStatus(`Could not start the microphone: ${(err as Error).message}`);
    }
  };

  return (
    <div className="panel">
      <header className="strip">
        <BoardPicker
          host={host}
          board={board}
          newRequest={newBoardRequest}
          onSwitch={(name) => void controller.switchTo(name).catch(report('switch boards'))}
          onCreate={(name) => void controller.createBoard(name).catch(report('create the board'))}
          onRename={(name) => void controller.renameBoard(name).catch(report('rename the board'))}
        />
        <TopStrip
          prompt={prompt}
          onDismissPrompt={() => setPrompt(undefined)}
          sendControl={
            <SendTo
              sessions={sessions}
              home={info.home}
              open={chooserOpen}
              onOpenChange={setChooserOpen}
              onSend={() => void send()}
              onSendTo={(id) => void sendTo(id)}
              onSendNew={(cwd, via) => void sendNew(cwd, via)}
              onFocus={(id) => void host.focusSession(id)}
              loadOptions={() => host.launchOptions()}
              chooseFolder={() => host.chooseFolder()}
            />
          }
          recording={recording}
          elapsedMs={elapsedMs}
          onMicrophone={() => void toggleRecording()}
          status={status}
        />
        <button className="ghost" onClick={() => setNotesOpen((o) => !o)} aria-pressed={notesOpen} data-testid="notes-toggle">
          Notes
        </button>
        <div className="anchor">
          <button
            className="ghost"
            aria-pressed={historyOpen}
            data-testid="history-toggle"
            onClick={() => setHistoryOpen((o) => !o)}
          >
            History
          </button>
          {historyOpen && (
            <HistoryPopover
              host={host}
              onOpen={(id) => {
                setHistoryOpen(false);
                void host
                  .restoreHistory(id)
                  .then((name) => controller.switchTo(name))
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
            data-testid="settings-toggle"
            onClick={() => setSettingsOpen((o) => !o)}
          >
            <GearIcon />
          </button>
          {settingsOpen && (
            <SettingsPopover
              settings={settings}
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
      </header>
      <main className="body">
        <BoardCanvas controller={controller} scene={scene} theme={theme} onReady={onReady} />
        {notesOpen && (
          <aside className="notes">
            <textarea
              data-testid="notes"
              placeholder={`Notes for ${board}`}
              value={notes}
              onChange={(e) => controller.setNotes(e.target.value)}
            />
          </aside>
        )}
      </main>
      {ipadOpen && ipad && (
        <IpadSheet
          status={ipad}
          onNewCode={() => void host.openIpad().then(setIpad)}
          onStop={() => void host.stopIpad().then(setIpad)}
          onRevoke={(id) => void host.revokeDevice(id).then(setIpad)}
          onClose={() => setIpadOpen(false)}
        />
      )}
    </div>
  );
}
