/** Turns two Excalidraw scenes into the stroke events the timeline reads. */

import type { ShapeType } from '../protocol';
import type { StrokeEvent } from './types';

/** The parts of an Excalidraw element this module reads. */
export interface ExcalidrawLikeElement {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  isDeleted?: boolean;
  customData?: { by?: 'claude'; sticky?: boolean; kind?: string };
  frameId?: string | null;
  /** Set on text bound to a container. */
  containerId?: string | null;
  text?: string;
  /** Frame title. */
  name?: string | null;
  boundElements?: readonly { id: string; type: string }[] | null;
}

/** Moves of 2 px or less are jitter and do not count. */
const MOVE_THRESHOLD_PX = 2;

const SHAPE_BY_EXCALIDRAW: Record<string, ShapeType> = {
  rectangle: 'rectangle',
  ellipse: 'ellipse',
  diamond: 'diamond',
  text: 'text',
  arrow: 'arrow',
  line: 'line',
  frame: 'frame',
  magicframe: 'frame',
  freedraw: 'freedraw',
};

/** Maps an Excalidraw element to a protocol shape. Unknown types read as rectangles. */
export function shapeOf(el: ExcalidrawLikeElement): ShapeType {
  if (el.type === 'rectangle' && (el.customData?.sticky || el.customData?.kind === 'sticky')) {
    return 'sticky';
  }
  return SHAPE_BY_EXCALIDRAW[el.type] ?? 'rectangle';
}

const isBoundText = (el: ExcalidrawLikeElement) => el.type === 'text' && !!el.containerId;
const isLive = (el: ExcalidrawLikeElement | undefined): el is ExcalidrawLikeElement =>
  el !== undefined && !el.isDeleted && el.type !== 'selection';

interface Index {
  byId: Map<string, ExcalidrawLikeElement>;
  /** Bound text by container id. */
  labels: Map<string, string>;
}

function index(elements: readonly ExcalidrawLikeElement[]): Index {
  const byId = new Map<string, ExcalidrawLikeElement>();
  const labels = new Map<string, string>();
  for (const el of elements) {
    byId.set(el.id, el);
    if (isBoundText(el) && !el.isDeleted && el.text) labels.set(el.containerId!, el.text);
  }
  return { byId, labels };
}

function labelOf(el: ExcalidrawLikeElement, labels: Map<string, string>): string | undefined {
  const text = el.type === 'text' ? el.text : el.type === 'frame' || el.type === 'magicframe' ? el.name : labels.get(el.id);
  return text || undefined;
}

function event(
  el: ExcalidrawLikeElement,
  labels: Map<string, string>,
  kind: StrokeEvent['kind'],
  t: number,
): StrokeEvent {
  const label = labelOf(el, labels);
  return {
    t,
    tEnd: t,
    elementId: el.id,
    type: el.type === 'image' ? 'image' : shapeOf(el),
    bbox: { x: el.x, y: el.y, width: el.width, height: el.height },
    ...(label ? { label } : {}),
    by: el.customData?.by === 'claude' ? 'claude' : 'user',
    kind,
  };
}

/** Compares scenes in O(n). Version bumps and text edits inside a container emit nothing. */
export function diffScene(
  prev: readonly ExcalidrawLikeElement[],
  next: readonly ExcalidrawLikeElement[],
  t: number,
): StrokeEvent[] {
  if (prev === next) return [];
  const before = index(prev);
  const after = index(next);
  const out: StrokeEvent[] = [];

  for (const el of next) {
    if (isBoundText(el) || el.type === 'selection') continue;
    const old = before.byId.get(el.id);
    if (el.isDeleted) {
      if (isLive(old)) out.push(event(old, before.labels, 'erase', t));
    } else if (!isLive(old)) {
      out.push(event(el, after.labels, 'add', t));
    } else if (
      Math.abs(el.x - old.x) > MOVE_THRESHOLD_PX ||
      Math.abs(el.y - old.y) > MOVE_THRESHOLD_PX
    ) {
      out.push(event(el, after.labels, 'move', t));
    }
  }

  for (const old of prev) {
    if (isBoundText(old) || !isLive(old) || after.byId.has(old.id)) continue;
    out.push(event(old, before.labels, 'erase', t));
  }
  return out;
}
