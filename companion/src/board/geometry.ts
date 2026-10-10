import type { Region } from '../server/contract';

export type Box = Region;

export type Point = [number, number];

/** The fields geometry needs from a scene element. */
export interface Shaped {
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  points?: readonly (readonly [number, number])[];
}

export const EMPTY_BOX: Box = { x: 0, y: 0, width: 0, height: 0 };

/** Axis-aligned box of an element. Linear elements use their points. */
export function boxOf(el: Shaped): Box {
  if (el.points && el.points.length > 0) {
    const xs = el.points.map((p) => p[0]);
    const ys = el.points.map((p) => p[1]);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    return {
      x: el.x + minX,
      y: el.y + minY,
      width: Math.max(...xs) - minX,
      height: Math.max(...ys) - minY,
    };
  }
  return { x: el.x, y: el.y, width: el.width, height: el.height };
}

/** True when the boxes overlap or touch. Zero-size boxes count as points. */
export function intersects(a: Box, b: Box): boolean {
  return a.x <= b.x + b.width && b.x <= a.x + a.width && a.y <= b.y + b.height && b.y <= a.y + a.height;
}

export function union(boxes: Box[]): Box {
  if (boxes.length === 0) return { ...EMPTY_BOX };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const b of boxes) {
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.width);
    maxY = Math.max(maxY, b.y + b.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function pad(box: Box, by: number, top = by): Box {
  return { x: box.x - by, y: box.y - top, width: box.width + by * 2, height: box.height + by + top };
}

export function center(box: Box): Point {
  return [box.x + box.width / 2, box.y + box.height / 2];
}

/** Parses `x,y,w,h`. Returns undefined for anything else. */
export function parseRegion(text: string | undefined | null): Box | undefined {
  if (!text) return undefined;
  const parts = text.split(',').map((s) => Number(s.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return undefined;
  const [x, y, width, height] = parts;
  if (width <= 0 || height <= 0) return undefined;
  return { x, y, width, height };
}

/** Scale that brings the long edge down to `maxEdge`, capped at `maxScale`. */
export function fitScale(width: number, height: number, maxEdge: number, maxScale = 2): number {
  const long = Math.max(width, height);
  if (long <= 0) return 1;
  return Math.min(maxScale, maxEdge / long);
}

/**
 * Where a ray from the shape's centre towards `toward` leaves the outline.
 * Rectangles, frames and text use their box; ellipses and diamonds their own curve.
 */
export function edgePoint(shape: Shaped, toward: Point): Point {
  const [cx, cy] = center(shape);
  const dx = toward[0] - cx;
  const dy = toward[1] - cy;
  if (dx === 0 && dy === 0) return [cx, cy];
  const hw = shape.width / 2;
  const hh = shape.height / 2;
  let t: number;
  if (shape.type === 'ellipse') {
    t = 1 / Math.sqrt((dx / hw) ** 2 + (dy / hh) ** 2);
  } else if (shape.type === 'diamond') {
    t = 1 / (Math.abs(dx) / hw + Math.abs(dy) / hh);
  } else {
    t = Math.min(dx === 0 ? Infinity : hw / Math.abs(dx), dy === 0 ? Infinity : hh / Math.abs(dy));
  }
  return [cx + dx * t, cy + dy * t];
}

/** Moves `from` towards `to` by `distance`. */
export function stepToward(from: Point, to: Point, distance: number): Point {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const len = Math.hypot(dx, dy);
  if (len === 0) return from;
  const d = Math.min(distance, len / 2);
  return [from[0] + (dx / len) * d, from[1] + (dy / len) * d];
}

export type End = { shape: Shaped } | { point: Point };

/** Gap between a bound arrow tip and its shape, in scene units. */
export const ARROW_GAP = 8;

/**
 * A straight route between two ends. Shape ends aim centre to centre and stop
 * `gap` short of the outline.
 */
export function route(start: End, end: End, gap = ARROW_GAP): { from: Point; to: Point } {
  const aim = (e: End): Point => ('shape' in e ? center(e.shape) : e.point);
  const startAim = aim(start);
  const endAim = aim(end);
  let from = 'shape' in start ? edgePoint(start.shape, endAim) : start.point;
  let to = 'shape' in end ? edgePoint(end.shape, startAim) : end.point;
  if ('shape' in start) from = stepToward(from, to, gap);
  if ('shape' in end) to = stepToward(to, from, gap);
  return { from, to };
}

/**
 * Where an element's stroke starts, and a point a little way along it.
 * Shapes start at their top-left corner and run towards their centre.
 */
export function strokeStart(el: Shaped): { start: Point; along: Point } {
  if (el.points && el.points.length > 0) {
    const start: Point = [el.x + el.points[0][0], el.y + el.points[0][1]];
    const next = el.points.find((p) => Math.hypot(p[0] - el.points![0][0], p[1] - el.points![0][1]) >= 10) ?? el.points[el.points.length - 1];
    return { start, along: [el.x + next[0], el.y + next[1]] };
  }
  return { start: [el.x, el.y], along: center(el) };
}

/**
 * Centre for a badge of `radius` next to `start`, on the side away from
 * `along`, `clearance` beyond the start point so it does not cover the ink.
 */
export function badgeCentre(start: Point, along: Point, radius: number, clearance: number): Point {
  let dx = start[0] - along[0];
  let dy = start[1] - along[1];
  const len = Math.hypot(dx, dy);
  if (len === 0) [dx, dy] = [-Math.SQRT1_2, -Math.SQRT1_2];
  else [dx, dy] = [dx / len, dy / len];
  const d = radius + clearance;
  return [start[0] + dx * d, start[1] + dy * d];
}
