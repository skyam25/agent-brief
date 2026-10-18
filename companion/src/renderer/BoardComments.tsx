/**
 * Comments on the board: a tool that drops numbered pins on elements, the pins
 * floating over the canvas, and the column of cards beside it.
 */

import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { useEffect, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import { boxOf, type Shaped } from '../board/geometry';
import { pinSpot, pinTarget, type Pinnable } from '../board/pin';
import { pinLabel, type BoardPin } from '../shared/board-comments';
import type { BoardCommentsStore } from './board-comments';
import { useStore } from './hooks';
import { CommentIcon, TrashIcon } from './Icons';
import { OVERALL, type ReviewVoice } from './review-voice';
import { VoiceState } from './ReviewView';

const editable = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA');

/** The board bar's toggle for the comment tool. */
export function CommentToggle({ comments }: { comments: BoardCommentsStore }) {
  const { tool } = useStore(comments);
  return (
    <button
      className="ghost pill"
      aria-pressed={tool}
      title={tool ? 'Stop commenting (Esc)' : 'Pin comments to the board, then talk or type (C)'}
      onClick={() => comments.setTool(!tool)}
      data-testid="comment-tool"
    >
      <CommentIcon /> Comment
    </button>
  );
}

/** C turns the comment tool on and off while the board shows. Esc turns it off. */
export function useCommentKeys(comments: BoardCommentsStore, active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || editable(document.activeElement)) return;
      if (e.key === 'c' && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        comments.setTool(!comments.tool);
      } else if (e.key === 'Escape' && comments.tool) {
        comments.setTool(false);
      }
    };
    document.addEventListener('keydown', onKey, { capture: true });
    return () => document.removeEventListener('keydown', onKey, { capture: true });
  }, [comments, active]);
}

/** Re-renders on every Excalidraw change, at most once a frame, so pins track scrolls, zooms and moves. */
function useSceneTick(api: ExcalidrawImperativeAPI): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    let frame = 0;
    const off = api.onChange(() => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        setTick((t) => t + 1);
      });
    });
    return () => {
      off();
      cancelAnimationFrame(frame);
    };
  }, [api]);
}

/**
 * The pins over the canvas, and the click that drops one while the tool is on.
 * The layer sits inside `root`, the canvas box, which shares Excalidraw's origin.
 */
export function PinLayer(props: { api: ExcalidrawImperativeAPI; root: HTMLElement; comments: BoardCommentsStore; board: string }) {
  const { api, root, comments, board } = props;
  useStore(comments);
  useSceneTick(api);
  const { tool, selected } = comments;

  useEffect(() => {
    root.dataset.commenting = String(tool);
    if (!tool) return;
    // Runs before Excalidraw sees the press, so the click pins instead of selecting or drawing.
    const onDown = (e: PointerEvent) => {
      const onBoard = e.target instanceof HTMLCanvasElement || (e.target instanceof HTMLElement && !!e.target.closest('[id*="-frame-name-"]'));
      if (!onBoard || e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const { offsetLeft, offsetTop, scrollX, scrollY, zoom } = api.getAppState();
      const at: [number, number] = [(e.clientX - offsetLeft) / zoom.value - scrollX, (e.clientY - offsetTop) / zoom.value - scrollY];
      const target = pinTarget(api.getSceneElements() as unknown as Pinnable[], at);
      comments.add(board, { x: at[0], y: at[1], ...target });
      // Focus moves to the new card, so typing goes straight in.
      requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('[data-testid="board-comment-card"].active textarea')?.focus());
    };
    root.addEventListener('pointerdown', onDown, { capture: true });
    return () => {
      root.removeEventListener('pointerdown', onDown, { capture: true });
      delete root.dataset.commenting;
    };
  }, [api, root, comments, board, tool]);

  const { pins } = comments.of(board);
  if (!pins.length && !tool) return null;
  const { scrollX, scrollY, zoom } = api.getAppState();
  const byId = new Map((api.getSceneElements() as unknown as Pinnable[]).map((e) => [e.id, e]));
  const toView = (x: number, y: number) => ({ left: (x + scrollX) * zoom.value, top: (y + scrollY) * zoom.value });
  const active = pins.find((p) => p.id === selected);
  const outlined = active?.elementId ? byId.get(active.elementId) : undefined;
  const box = outlined && boxOf(outlined as Shaped);

  return (
    <div className="pin-layer" data-testid="pin-layer">
      {box && (
        <div
          className="pin-outline"
          style={{ ...toView(box.x, box.y), width: box.width * zoom.value, height: box.height * zoom.value }}
          aria-hidden="true"
        />
      )}
      {pins.map((p, i) => {
        const { at, gone } = pinSpot(p, byId);
        return (
          <button
            key={p.id}
            className={`board-pin${p.id === selected ? ' active' : ''}${gone ? ' gone' : ''}`}
            style={toView(at[0], at[1])}
            title={pinLabel(p)}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => {
              comments.select(p.id);
              document.querySelector(`[data-pin="${p.id}"]`)?.scrollIntoView({ block: 'nearest' });
            }}
            data-board-pin={p.id}
            data-testid="board-pin"
          >
            {i + 1}
          </button>
        );
      })}
      {tool && (
        <div className="review-hint" data-testid="comment-hint">
          Click to pin · <kbd>Esc</kbd> to draw
        </div>
      )}
    </div>
  );
}

/** The comment column beside the board: an overall note, then one card per pin. */
export function CommentColumn(props: { comments: BoardCommentsStore; board: string; voice: ReviewVoice; onSendKeys: (e: KeyboardEvent) => void }) {
  const { comments, board, voice } = props;
  useStore(comments);
  useSyncExternalStore(
    (fn) => voice.subscribe(fn),
    () => voice.version,
  );
  const { overall, pins } = comments.of(board);
  const select = (id: string | undefined) => {
    comments.select(id);
    voice.aim(id ?? OVERALL);
  };
  const remove = (id: string) => {
    if (voice.target === id) voice.aim(OVERALL);
    comments.remove(board, id);
  };

  return (
    <aside className="review-notes board-comments" aria-label="Comments" data-testid="board-comments">
      <label className={comments.selected === undefined && voice.recording ? 'review-overall listening' : 'review-overall'}>
        <span className="section-head">Overall</span>
        <textarea
          placeholder="Anything about the board as a whole"
          value={overall}
          onChange={(e) => comments.setOverall(board, e.target.value)}
          onFocus={() => select(undefined)}
          onKeyDown={props.onSendKeys}
          data-testid="board-overall"
        />
        <VoiceState voice={voice} target={OVERALL} />
      </label>
      <h3 className="section-head">
        Comments{pins.length > 0 && <span className="count">{pins.length}</span>}
      </h3>
      {pins.length === 0 ? (
        <p className="muted review-empty" data-testid="board-comments-empty">
          Click anything on the board to pin a comment, then type or talk.
        </p>
      ) : (
        <ol className="review-cards">
          {pins.map((p, i) => (
            <PinCard
              key={p.id}
              pin={p}
              n={i + 1}
              active={p.id === comments.selected}
              voice={voice}
              onSelect={() => select(p.id)}
              onEdit={(text) => comments.edit(board, p.id, text)}
              onRemove={() => remove(p.id)}
              onKeyDown={props.onSendKeys}
            />
          ))}
        </ol>
      )}
      <footer className="muted review-foot">
        {pins.length > 0 ? 'Send hands Claude each pin with its element. ⌘↩ sends.' : 'Draw as well as pin. Send takes both.'}
      </footer>
    </aside>
  );
}

function PinCard(props: {
  pin: BoardPin;
  n: number;
  active: boolean;
  voice: ReviewVoice;
  onSelect: () => void;
  onEdit: (text: string) => void;
  onRemove: () => void;
  onKeyDown: (e: KeyboardEvent) => void;
}) {
  const { pin: p } = props;
  const listening = props.voice.recording && props.voice.target === p.id;
  return (
    <li
      className={`review-card${props.active ? ' active' : ''}${listening ? ' listening' : ''}`}
      data-pin={p.id}
      data-testid="board-comment-card"
      onClick={(e) => {
        if (!(e.target as HTMLElement).closest('button, textarea')) props.onSelect();
      }}
    >
      <div className="review-card-head">
        <button className="ghost pin-badge" title="Select this pin" onClick={props.onSelect}>
          {props.n}
        </button>
        <span className="review-anchor" title={p.frame ? `In ${p.frame}` : undefined}>
          {pinLabel(p, 40)}
        </span>
        <button className="ghost icon-button small" aria-label={`Delete comment ${props.n}`} title="Delete" onClick={props.onRemove} data-testid="board-comment-delete">
          <TrashIcon />
        </button>
      </div>
      <textarea
        placeholder={listening ? 'Listening…' : 'What should change here?'}
        value={p.text}
        rows={2}
        onChange={(e) => props.onEdit(e.target.value)}
        onFocus={props.onSelect}
        onKeyDown={props.onKeyDown}
        data-testid="board-comment-text"
      />
      <VoiceState voice={props.voice} target={p.id} />
    </li>
  );
}
