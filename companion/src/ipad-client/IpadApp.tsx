import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { hasBoardComments } from '../shared/board-comments';
import type { IpadUtterance } from '../shared/ipad';
import type { Theme } from '../shared/ipc';
import { BoardCanvas } from '../renderer/BoardCanvas';
import { BoardCommentsStore } from '../renderer/board-comments';
import { BoardController, parseScene } from '../renderer/controller';
import { CommentColumn } from '../renderer/BoardComments';
import { useStore } from '../renderer/hooks';
import { OVERALL } from '../renderer/review-voice';
import type { ColumnVoice } from '../renderer/VoiceState';
import { fitBoard } from '../renderer/viewport';
import { deliveryOf, targetAt, type VoiceAim } from './capture';
import { IpadHost, toNative, type OpenBoard } from './host';
import { keepPinch } from './pinch';
import { refitWhileSettling } from './settle-fit';

/** What the native app calls. `collect` answers JSON, because a delivery can hold many megabytes. */
export interface IpadBridge {
  open(board: OpenBoard): Promise<void>;
  collect(spoken: IpadUtterance[], board: string): Promise<string>;
  setTheme(theme: Theme): void;
  /** Turns the comment tool on or off. */
  setCommenting(on: boolean): void;
  /** Tells the comment column whether the mic is on. */
  setListening(on: boolean): void;
  /** Offers a heard phrase. True means a comment took it, so it stays out of the timeline. */
  heard(text: string, t: number): boolean;
}

declare global {
  interface Window {
    __ipad?: IpadBridge;
  }
}

const START_BOARD = '__start';

/** The native app owns the mic, so this only says where its words will land. */
class NativeVoice implements ColumnVoice {
  version = 0;
  recording = false;
  starting = false;
  target = OVERALL;
  pending = new Map<string, number>();
  settling = new Map<string, string>();
  private readonly listeners = new Set<() => void>();

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    this.version++;
    for (const fn of this.listeners) fn();
  }

  setRecording(on: boolean): void {
    this.recording = on;
    this.emit();
  }

  aim(target: string): void {
    this.target = target;
    this.emit();
  }
}

export function IpadApp() {
  const host = useMemo(() => new IpadHost(), []);
  const scene = useMemo(() => parseScene(null), []);
  const controller = useMemo(() => new BoardController(host, { board: START_BOARD, notes: '', scene }), [host, scene]);
  const comments = useMemo(() => new BoardCommentsStore(host), [host]);
  const voice = useMemo(() => new NativeVoice(), []);
  const board = useSyncExternalStore((fn) => controller.subscribe(fn), () => controller.board);
  const aims = useRef<VoiceAim[]>([]);
  useStore(comments);
  const [theme, setTheme] = useState<Theme>('light');

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  // The mic and new pins both follow the selected comment.
  useEffect(() => {
    let last = comments.selected;
    return comments.subscribe(() => {
      if (comments.selected === last) return;
      last = comments.selected;
      aims.current.push({ at: comments.selectedAt, target: last });
      voice.aim(last ?? OVERALL);
    });
  }, [comments, voice]);

  const onReady = useCallback(
    (api: ExcalidrawImperativeAPI) => {
      api.setActiveTool({ type: 'freedraw' });
      const root = document.querySelector<HTMLElement>('.ipad-board');
      if (root) keepPinch(root, api);
      let settling: (() => void) | undefined;
      window.__ipad = {
        async open(board) {
          host.offer(board);
          await comments.load();
          comments.setTool(false);
          comments.select(undefined);
          aims.current = [];
          await controller.switchTo(board.boardName);
          api.setActiveTool({ type: 'freedraw' });
          settling?.();
          const view = document.querySelector<HTMLElement>('.ipad-board .excalidraw');
          if (view) settling = refitWhileSettling(view, () => fitBoard(api, api.getSceneElements()));
        },
        async collect(spoken, board) {
          await comments.flush();
          const pinned = comments.of(board);
          const reviewed = hasBoardComments(pinned);
          const payload = await controller.payload(reviewed ? pinned.pins : undefined);
          const events = controller.strokes.events;
          const origin = events.length ? Math.min(...events.map((e) => e.t)) : undefined;
          return JSON.stringify(deliveryOf(payload, origin, spoken, board, reviewed ? pinned : undefined));
        },
        setTheme,
        setCommenting(on) {
          comments.setTool(on);
          // Fingers still pan and pinch while pinning, and only a tap drops a pin.
          api.setActiveTool({ type: on ? 'hand' : 'freedraw' });
        },
        setListening: (on) => voice.setRecording(on),
        heard(text, t) {
          const open = controller.board;
          if (!comments.tool && !hasBoardComments(comments.of(open))) return false;
          comments.append(open, targetAt(aims.current, t) ?? OVERALL, text);
          return true;
        },
      };
      toNative({ type: 'ready' });
    },
    [comments, controller, host, voice],
  );
  const commenting = board !== START_BOARD && (comments.tool || hasBoardComments(comments.of(board)));

  return (
    <div className="ipad-board">
      <BoardCanvas controller={controller} scene={scene} theme={theme} active onReady={onReady} comments={comments} board={board} />
      {commenting && <CommentColumn comments={comments} board={board} voice={voice} onSendKeys={() => {}} foot="Send hands Claude each pin with its element." />}
    </div>
  );
}
