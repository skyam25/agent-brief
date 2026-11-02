import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { IpadUtterance } from '../shared/ipad';
import type { Theme } from '../shared/ipc';
import { BoardCanvas } from '../renderer/BoardCanvas';
import { BoardCommentsStore } from '../renderer/board-comments';
import { BoardController, parseScene } from '../renderer/controller';
import { deliveryOf } from './capture';
import { IpadHost, toNative, type OpenBoard } from './host';

/** What the native app calls. `collect` answers JSON, because a delivery can hold many megabytes. */
export interface IpadBridge {
  open(board: OpenBoard): Promise<void>;
  collect(spoken: IpadUtterance[], board: string): Promise<string>;
  setTheme(theme: Theme): void;
}

declare global {
  interface Window {
    __ipad?: IpadBridge;
  }
}

const START_BOARD = '__start';

export function IpadApp() {
  const host = useMemo(() => new IpadHost(), []);
  const scene = useMemo(() => parseScene(null), []);
  const controller = useMemo(() => new BoardController(host, { board: START_BOARD, notes: '', scene }), [host, scene]);
  const comments = useMemo(() => new BoardCommentsStore(), []);
  const [theme, setTheme] = useState<Theme>('light');

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const onReady = useCallback(
    (api: ExcalidrawImperativeAPI) => {
      api.setActiveTool({ type: 'freedraw' });
      window.__ipad = {
        async open(board) {
          host.offer(board);
          await controller.switchTo(board.boardName);
          api.setActiveTool({ type: 'freedraw' });
        },
        async collect(spoken, board) {
          const payload = await controller.payload();
          const events = controller.strokes.events;
          const origin = events.length ? Math.min(...events.map((e) => e.t)) : undefined;
          return JSON.stringify(deliveryOf(payload, origin, spoken, board));
        },
        setTheme,
      };
      toNative({ type: 'ready' });
    },
    [controller, host],
  );

  return (
    <div className="ipad-board">
      <BoardCanvas controller={controller} scene={scene} theme={theme} active onReady={onReady} comments={comments} board={controller.board} />
    </div>
  );
}
