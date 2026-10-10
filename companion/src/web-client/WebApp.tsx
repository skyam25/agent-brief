import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import type { Theme } from '../shared/ipc';
import { BoardCanvas } from '../renderer/BoardCanvas';
import { BoardPicker } from '../renderer/BoardPicker';
import { BoardController, parseScene, type LoadedScene } from '../renderer/controller';
import { TopStrip } from '../renderer/TopStrip';
import type { WebHost } from './host';

interface Boot {
  controller: BoardController;
  scene: LoadedScene;
}

const NOT_PAIRED =
  'This device is not paired with the Mac. On the Mac, choose File > Open on iPad… and scan the code again.';

export function WebApp({ host }: { host: WebHost }) {
  const [booted, setBooted] = useState<Boot>();
  const [unpaired, setUnpaired] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    host.onUnpaired = () => setUnpaired(true);
    void (async () => {
      try {
        const board = await host.startBoard();
        const { scene } = await host.loadBoard(board);
        const loaded = parseScene(scene);
        setBooted({ controller: new BoardController(host, { board, notes: '', scene: loaded }), scene: loaded });
      } catch (err) {
        setError((err as Error).message);
      }
    })();
  }, [host]);

  if (unpaired) return <Notice text={NOT_PAIRED} />;
  if (error) return <Notice text={error} />;
  if (!booted) return null;
  return <WebPanel host={host} {...booted} />;
}

function Notice({ text }: { text: string }) {
  return (
    <div className="notice" role="alert" data-testid="notice">
      {text}
    </div>
  );
}

function WebPanel({ host, controller, scene }: Boot & { host: WebHost }) {
  const board = useSyncExternalStore(
    (fn) => controller.subscribe(fn),
    () => controller.board,
  );
  const [theme, setTheme] = useState<Theme>(host.theme());
  const [status, setStatus] = useState<string>();
  const [live, setLive] = useState(true);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    host.onTheme(setTheme);
    host.onConnection = setLive;
    host.onRemoteElements((name, elements) => controller.applyRemote(name, elements));
  }, [host, controller]);

  const onReady = useCallback(
    (api: ExcalidrawImperativeAPI) => {
      // Pages and tests on the same origin can reach the board through these.
      Object.assign(window, { __board: controller, __excalidraw: api });
    },
    [controller],
  );

  const send = async () => {
    setStatus('Sending…');
    const result = await host.send(await controller.payload());
    if (result.ok) controller.clearBoard();
    setStatus(result.message);
  };

  return (
    <div className="panel">
      <header className="strip">
        <BoardPicker
          host={host}
          board={board}
          canEdit={false}
          onSwitch={(name) => void controller.switchTo(name).catch((err) => setStatus((err as Error).message))}
          onCreate={() => {}}
          onRename={() => {}}
        />
        <TopStrip
          onDismissPrompt={() => {}}
          target={live ? 'Sends to the session chosen on the Mac' : 'Reconnecting to the Mac…'}
          voiceNote="Voice records on the Mac"
          onSend={() => void send()}
          status={status}
        />
      </header>
      <main className="body">
        <BoardCanvas controller={controller} scene={scene} theme={theme} onReady={onReady} />
      </main>
    </div>
  );
}
