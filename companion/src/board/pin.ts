/** Where a comment pin lands on the board: the element under it, and how the pin follows that element. */

import { boxOf, type Point, type Shaped } from './geometry';

/** The fields pinning needs from a scene element. */
export interface Pinnable extends Shaped {
  id: string;
  isDeleted?: boolean;
  frameId?: string | null;
  containerId?: string | null;
  text?: string;
  name?: string | null;
}

export interface PinTarget {
  elementId: string;
  type: string;
  label?: string;
  frame?: string;
  fx: number;
  fy: number;
}

const LINEAR = new Set(['arrow', 'line', 'freedraw']);

/** Slack around thin elements, in scene units, so a line is not impossible to hit. */
const SLACK = 6;

const contains = (el: Pinnable, [x, y]: Point, slack = 0) => {
  const b = boxOf(el);
  return x >= b.x - slack && x <= b.x + b.width + slack && y >= b.y - slack && y <= b.y + b.height + slack;
};

/** A frame's title as Excalidraw shows it. */
const frameTitle = (f: Pinnable) => f.name?.trim() || 'Frame';

/**
 * The element a pin at `point` belongs to. Shapes, text and pictures win over
 * lines and arrows, which win over frames; within each, the topmost wins.
 * Text inside a shape pins the shape.
 */
export function pinTarget(elements: readonly Pinnable[], point: Point): PinTarget | undefined {
  const live = elements.filter((e) => !e.isDeleted);
  const byId = new Map(live.map((e) => [e.id, e]));
  const top = [...live].reverse();
  const hit =
    top.find((e) => e.type !== 'frame' && !LINEAR.has(e.type) && contains(e, point)) ??
    top.find((e) => LINEAR.has(e.type) && contains(e, point, SLACK)) ??
    top.find((e) => e.type === 'frame' && contains(e, point));
  if (!hit) return undefined;
  const el = (hit.containerId && byId.get(hit.containerId)) || hit;
  const box = boxOf(el);
  const inside = (v: number, start: number, size: number) => (size > 0 ? Math.min(1, Math.max(0, (v - start) / size)) : 0.5);
  const bound = live.find((e) => e.type === 'text' && e.containerId === el.id);
  const label = el.type === 'frame' ? frameTitle(el) : (el.text ?? bound?.text)?.trim() || undefined;
  const frame = el.frameId ? byId.get(el.frameId) : undefined;
  return {
    elementId: el.id,
    type: el.type,
    ...(label ? { label } : {}),
    ...(frame ? { frame: frameTitle(frame) } : {}),
    fx: inside(point[0], box.x, box.width),
    fy: inside(point[1], box.y, box.height),
  };
}

/** Where a pin sits now: on its element as it moved, or where it dropped when the element is gone. */
export function pinSpot(
  pin: { elementId?: string; x: number; y: number; fx?: number; fy?: number },
  byId: ReadonlyMap<string, Pinnable>,
): { at: Point; gone: boolean } {
  const el = pin.elementId ? byId.get(pin.elementId) : undefined;
  if (!pin.elementId) return { at: [pin.x, pin.y], gone: false };
  if (!el || el.isDeleted || pin.fx === undefined || pin.fy === undefined) return { at: [pin.x, pin.y], gone: !el || !!el.isDeleted };
  const b = boxOf(el);
  return { at: [b.x + pin.fx * b.width, b.y + pin.fy * b.height], gone: false };
}
