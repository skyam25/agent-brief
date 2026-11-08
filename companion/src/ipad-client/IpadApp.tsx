import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { hasBoardComments } from '../shared/board-comments';
import type { IpadUtterance } from '../shared/ipad';
import type { Theme } from '../shared/ipc';
import { BoardCanvas } from '../renderer/BoardCanvas';
import { BoardCommentsStore } from '../renderer/board-comments';
import { BoardController, parseScene } from '../renderer/controller';
import { CommentColumn } from '../renderer/BoardComments';
import { useStore } from '../renderer/hooks';
import { OVERALL, routeWords, type HeardWord } from '../renderer/review-voice';
import type { ColumnVoice } from '../renderer/VoiceState';
import { fitBoard } from '../renderer/viewport';
import { deliveryOf } from './capture';
import { IpadHost, toNative, type OpenBoard } from './host';
import { keepPinch } from './pinch';
import { press, watchHistory } from './history';
import { refitWhileSettling } from './settle-fit';

/** What the native app calls. `collect` answers JSON, because a delivery can hold many megabytes. */
export interface IpadBridge {
  open(board: OpenBoard): Promise<void>;
  collect(spoken: IpadUtterance[], board: string): Promise<string>;
  setTheme(theme: Theme): void;
  /** Turns the comment tool on or off. */
  setCommenting(on: boolean): void;
  /** Shows or hides the side panel. */
  setPanel(open: boolean): void;
  /** Where the fold runs on a partly folded phone, in page pixels. Undefined when flat. */
  setFold(fold?: Fold): void;
  /** Tells the comment column whether the mic is on. */
  setListening(on: boolean): void;
  /** Offers a finished phrase. True means comments took it, so it stays out of the timeline. */
  heard(text: string, t: number, words?: HeardWord[]): boolean;
  /** Offers words still settling. True means a comment shows them. */
  live(text: string, t: number, words?: HeardWord[]): boolean;
  /** Undoes the last change on the board, as the toolbar's Undo. */
  undo(): void;
  redo(): void;
}

declare global {
  interface Window {
    __ipad?: IpadBridge;
  }
}

const START_BOARD = '__start';

export interface Fold {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The panel's place beside a fold: the far side of an upright fold, or under a flat one. */
export function besideFold(fold: Fold | undefined, page: { width: number; height: number }): { side: number } | { under: number } | undefined {
  if (!fold) return undefined;
  if (fold.height >= fold.width) return { side: Math.max(0, page.width - (fold.x + fold.width)) };
  return { under: Math.max(0, page.height - (fold.y + fold.height)) };
}

/** Words go to comments while the pin tool is on or the board has some. */
const takesWords = (comments: BoardCommentsStore, board: string) => comments.tool || hasBoardComments(comments.of(board));

/** Where the voice pointed from `at` on, oldest first. */
type Aim = { at: number; target: string };
const startAims = (): Aim[] => [{ at: 0, target: OVERALL }];

/** The native app owns the mic, so this only says where its words will land. */
class NativeVoice implements ColumnVoice {
  version = 0;
  starting = false;
  target = OVERALL;
  pending = new Map<string, number>();
  settling = new Map<string, string>();
  private readonly listeners = new Set<() => void>();
  private mic = false;

  /** `takes` says whether comments take words right now. Without it the column says nothing about the mic. */
  constructor(private readonly takes: () => boolean) {}

  get recording(): boolean {
    return this.mic && this.takes();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    this.version++;
    for (const fn of this.listeners) fn();
  }

  setRecording(on: boolean): void {
    this.mic = on;
    if (!on) this.settling = new Map();
    this.emit();
  }

  aim(target: string): void {
    this.target = target;
    this.emit();
  }

  settle(words: Map<string, string>): void {
    this.settling = words;
    this.emit();
  }
}

export function IpadApp() {
  const host = useMemo(() => new IpadHost(), []);
  const scene = useMemo(() => parseScene(null), []);
  const controller = useMemo(() => new BoardController(host, { board: START_BOARD, notes: '', scene }), [host, scene]);
  const comments = useMemo(() => new BoardCommentsStore(host), [host]);
  const voice = useMemo(() => new NativeVoice(() => takesWords(comments, controller.board)), [comments, controller]);
  const board = useSyncExternalStore((fn) => controller.subscribe(fn), () => controller.board);
  const aims = useRef<Aim[]>(startAims());
  const api = useRef<ExcalidrawImperativeAPI>(undefined);
  useStore(comments);
  const [theme, setTheme] = useState<Theme>('light');
  const [panel, setPanel] = useState(true);
  const [fold, setFold] = useState<Fold>();
  const placed = besideFold(fold, { width: window.innerWidth, height: window.innerHeight });

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  // The mic and new pins both follow the selected comment.
  useEffect(() => {
    let last = comments.selected;
    return comments.subscribe(() => {
      if (comments.selected === last) return;
      last = comments.selected;
      aims.current.push({ at: comments.selectedAt, target: last ?? OVERALL });
      voice.aim(last ?? OVERALL);
    });
  }, [comments, voice]);

  // Fingers still pan and pinch while pinning, and only a tap drops a pin.
  const setCommenting = useCallback(
    (on: boolean) => {
      comments.setTool(on);
      api.current?.setActiveTool({ type: on ? 'hand' : 'freedraw' });
    },
    [comments],
  );

  const onReady = useCallback(
    (excalidraw: ExcalidrawImperativeAPI) => {
      api.current = excalidraw;
      excalidraw.setActiveTool({ type: 'freedraw' });
      const root = document.querySelector<HTMLElement>('.ipad-board');
      if (root) keepPinch(root, excalidraw);

      const takes = () => takesWords(comments, controller.board);
      let settling: (() => void) | undefined;

      window.__ipad = {
        async open(board) {
          host.offer(board);
          await comments.load();
          setCommenting(false);
          comments.select(undefined);
          aims.current = startAims();
          voice.settle(new Map());
          await controller.switchTo(board.boardName);
          excalidraw.setActiveTool({ type: 'freedraw' });
          settling?.();
          const view = document.querySelector<HTMLElement>('.ipad-board .excalidraw');
          if (view) settling = refitWhileSettling(view, () => fitBoard(excalidraw, excalidraw.getSceneElements()));
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
        setCommenting,
        setPanel(open) {
          setPanel(open);
          if (!open) setCommenting(false);
        },
        setFold,
        setListening: (on) => voice.setRecording(on),
        heard(text, t, words) {
          voice.settle(new Map());
          if (!takes()) return false;
          for (const [target, said] of routeWords(aims.current, text, t, words)) comments.append(controller.board, target, said);
          return true;
        },
        live(text, t, words) {
          if (!takes()) {
            if (voice.settling.size) voice.settle(new Map());
            return false;
          }
          voice.settle(routeWords(aims.current, text, t, words));
          return true;
        },
        undo() {
          if (root) press(root, 'undo');
        },
        redo() {
          if (root) press(root, 'redo');
        },
      };
      if (root) watchHistory(root, (state) => toNative({ type: 'history', ...state }));
      toNative({ type: 'ready' });
    },
    [comments, controller, host, setCommenting, voice],
  );

  return (
    <div className={`ipad-board${placed ? ('side' in placed ? ' fold-side' : ' fold-under') : ''}`}>
      <BoardCanvas controller={controller} scene={scene} theme={theme} active onReady={onReady} comments={comments} board={board} />
      {panel && board !== START_BOARD && (
        <IpadPanel
          comments={comments}
          controller={controller}
          board={board}
          voice={voice}
          onPin={() => setCommenting(!comments.tool)}
          style={placed ? ('side' in placed ? { width: placed.side } : { height: placed.under, maxHeight: 'none' }) : undefined}
        />
      )}
    </div>
  );
}

/** The side panel: pins and the note, one tab at a time. Narrow screens dock it under the board. */
function IpadPanel(props: { comments: BoardCommentsStore; controller: BoardController; board: string; voice: NativeVoice; onPin: () => void; style?: CSSProperties }) {
  const { comments, controller, board, voice } = props;
  const [tab, setTab] = useState<'comments' | 'note'>('comments');
  const notes = useSyncExternalStore((fn) => controller.subscribe(fn), () => controller.notes);
  useStore(comments);
  const count = comments.of(board).pins.length;

  return (
    <section className="ipad-panel" style={props.style} aria-label="Comments and note" data-testid="ipad-panel">
      <div className="ipad-panel-head">
        <div className="ipad-tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'comments'} onClick={() => setTab('comments')} data-testid="panel-comments-tab">
            Comments{count > 0 && <span className="count">{count}</span>}
          </button>
          <button role="tab" aria-selected={tab === 'note'} onClick={() => setTab('note')} data-testid="panel-note-tab">
            Note{notes.trim() && <span className="ipad-dot" aria-label="has text" />}
          </button>
        </div>
        {tab === 'comments' && (
          <button className="ipad-pin" aria-pressed={comments.tool} onClick={props.onPin} data-testid="pin-toggle">
            {comments.tool ? 'Done' : 'Pin'}
          </button>
        )}
      </div>
      {tab === 'comments' ? (
        <CommentColumn comments={comments} board={board} voice={voice} onSendKeys={() => {}} compact />
      ) : (
        <textarea
          className="ipad-note"
          placeholder="Anything the drawing doesn't say"
          value={notes}
          onChange={(e) => controller.setNotes(e.target.value)}
          data-testid="note-editor"
        />
      )}
    </section>
  );
}
