/**
 * Turns protocol skeletons into Excalidraw skeletons. Pure: ids, defaults,
 * colours and auto-layout are settled here; text measuring and arrow routing
 * happen later against real geometry.
 */

import type { Skeleton } from '../protocol';
import { badRequest } from './errors';
import { center, edgePoint, route, type Box, type End, type Point, type Shaped } from './geometry';
import { STICKY_COLOR, TEXT_COLOR, TEXT_FONT, swatch } from './palette';

/** An Excalidraw element skeleton, kept loose so this module stays free of Excalidraw imports. */
export type ExSkeleton = Record<string, unknown> & { type: string; id: string };

/** An arrow or line end: a shape, a point, or a point `delta` away from a shape. */
export type EndRef = { id: string } | { point: Point } | { beside: string; delta: Point };

export interface PlannedShape {
  id: string;
  skel: ExSkeleton;
  frameId?: string;
  sticky: boolean;
}

export interface PlannedFrame {
  id: string;
  skel: ExSkeleton;
  /** False when the caller left out the geometry, so it is fitted to the children. */
  placed: boolean;
}

export interface PlannedLinear {
  id: string;
  type: 'arrow' | 'line';
  skel: ExSkeleton;
  start: EndRef;
  end: EndRef;
  frameId?: string;
}

/** A picture an `image` element shows, in Excalidraw's BinaryFileData shape. */
export interface PlannedFile {
  id: string;
  dataURL: string;
  mimeType: string;
}

export interface DrawPlan {
  /** Final ids in request order. */
  ids: string[];
  shapes: PlannedShape[];
  frames: PlannedFrame[];
  linear: PlannedLinear[];
  files: PlannedFile[];
}

export const DEFAULT_SIZE: Record<string, { width: number; height: number }> = {
  rectangle: { width: 180, height: 80 },
  diamond: { width: 180, height: 100 },
  ellipse: { width: 160, height: 90 },
  sticky: { width: 180, height: 140 },
};

const DEFAULT_FRAME = { width: 400, height: 300 };
const DEFAULT_LINE_LENGTH = 120;
const LAYOUT_GAP = 60;
const LAYOUT_MARGIN = 80;

const KNOWN_TYPES = new Set(['rectangle', 'ellipse', 'diamond', 'text', 'sticky', 'arrow', 'line', 'frame', 'image']);

/** A label's alignment: the caller's, else left for a list and center for the rest. */
export function labelAlign(label: string, align?: 'left' | 'center'): 'left' | 'center' {
  if (align) return align;
  return /^\s*[-•] /m.test(label) ? 'left' : 'center';
}

export interface PlanContext {
  /** Live elements already on the board, by id. */
  existing: ReadonlyMap<string, Shaped>;
  /** Bounding box of the board, for placing elements that come without a position. */
  sceneBounds: Box;
  newId: () => string;
  /** Ids in use that `existing` leaves out, such as deleted elements. */
  taken?: (id: string) => boolean;
}

/** Rough text width before measuring, used only to space out auto-placed text. */
function estimateTextWidth(text: string): number {
  const longest = Math.max(...text.split('\n').map((l) => l.length), 1);
  return Math.max(40, longest * 11);
}

export function planDraw(skeletons: Skeleton[], ctx: PlanContext): DrawPlan {
  if (!Array.isArray(skeletons)) throw badRequest('elements must be an array');

  // Settle final ids first so arrows and frame children can refer forward.
  const idMap = new Map<string, string>();
  const ids: string[] = [];
  for (const [i, s] of skeletons.entries()) {
    if (!s || typeof s !== 'object' || !KNOWN_TYPES.has(s.type)) {
      throw badRequest(`elements[${i}]: unknown type ${JSON.stringify(s?.type)}`);
    }
    const wanted = typeof s.id === 'string' && s.id.length > 0 ? s.id : undefined;
    const clash =
      wanted !== undefined && (ctx.existing.has(wanted) || idMap.has(wanted) || !!ctx.taken?.(wanted));
    const id = wanted && !clash ? wanted : ctx.newId();
    if (wanted && !idMap.has(wanted)) idMap.set(wanted, id);
    ids.push(id);
  }

  const resolve = (ref: string, what: string): string => {
    const local = idMap.get(ref);
    if (local) return local;
    if (ctx.existing.has(ref)) return ref;
    throw badRequest(`${what}: no element with id ${JSON.stringify(ref)}`);
  };

  // Elements without a position go in a row to the right of the board.
  const empty = ctx.sceneBounds.width === 0 && ctx.sceneBounds.height === 0;
  let cursorX = empty ? 0 : ctx.sceneBounds.x + ctx.sceneBounds.width + LAYOUT_MARGIN;
  const rowY = empty ? 0 : ctx.sceneBounds.y;
  const place = (width: number): Point => {
    const at: Point = [cursorX, rowY];
    cursorX += width + LAYOUT_GAP;
    return at;
  };

  const plan: DrawPlan = { ids, shapes: [], frames: [], linear: [], files: [] };

  for (const [i, s] of skeletons.entries()) {
    const id = ids[i];
    const where = `elements[${i}]`;
    const frameId = s.frameId !== undefined ? resolve(s.frameId, `${where}.frameId`) : undefined;
    if (frameId && !isFrame(frameId, skeletons, idMap, ctx)) {
      throw badRequest(`${where}.frameId: ${JSON.stringify(s.frameId)} is not a frame`);
    }

    switch (s.type) {
      case 'rectangle':
      case 'ellipse':
      case 'diamond':
      case 'sticky': {
        const sticky = s.type === 'sticky';
        const size = DEFAULT_SIZE[s.type];
        const width = num(s.width) ?? size.width;
        const height = num(s.height) ?? size.height;
        const [x, y] = hasPoint(s) ? [s.x!, s.y!] : place(width);
        const colors = swatch(s.color, sticky ? STICKY_COLOR : undefined);
        const skel: ExSkeleton = {
          type: sticky ? 'rectangle' : s.type,
          id,
          x,
          y,
          width,
          height,
          strokeColor: colors.stroke,
          backgroundColor: sticky ? colors.fill : 'transparent',
          fillStyle: 'solid',
          ...(sticky ? { roundness: { type: 3 } } : {}),
        };
        if (s.label) {
          skel.label = { text: s.label, strokeColor: TEXT_COLOR, fontFamily: TEXT_FONT, textAlign: labelAlign(s.label, s.align) };
        }
        plan.shapes.push({ id, skel, frameId, sticky });
        break;
      }
      case 'text': {
        const text = s.label ?? '';
        const [x, y] = hasPoint(s) ? [s.x!, s.y!] : place(estimateTextWidth(text));
        const strokeColor = s.color ? swatch(s.color).stroke : TEXT_COLOR;
        const skel: ExSkeleton = { type: 'text', id, x, y, text, strokeColor, fontFamily: TEXT_FONT };
        plan.shapes.push({ id, skel, frameId, sticky: false });
        break;
      }
      case 'image': {
        const dataURL = typeof s.image === 'string' ? s.image : '';
        const mimeType = /^data:(image\/[a-z]+);base64,/.exec(dataURL)?.[1];
        const width = num(s.width);
        const height = num(s.height);
        if (!mimeType) throw badRequest(`${where}.image must be a base64 image data URL`);
        if (!width || !height) throw badRequest(`${where} needs a width and height`);
        const [x, y] = hasPoint(s) ? [s.x!, s.y!] : place(width);
        const fileId = `file-${id}`;
        plan.files.push({ id: fileId, dataURL, mimeType });
        const skel: ExSkeleton = { type: 'image', id, x, y, width, height, fileId, status: 'saved', scale: [1, 1] };
        plan.shapes.push({ id, skel, frameId, sticky: false });
        break;
      }
      case 'frame': {
        const placed = hasPoint(s) && num(s.width) !== undefined && num(s.height) !== undefined;
        const skel: ExSkeleton = { type: 'frame', id, children: [] };
        if (placed) Object.assign(skel, { x: s.x, y: s.y, width: s.width, height: s.height });
        if (s.label) skel.name = s.label;
        plan.frames.push({ id, skel, placed });
        break;
      }
      case 'arrow':
      case 'line': {
        const start = endRef(s.start, `${where}.start`, resolve);
        const end = endRef(s.end, `${where}.end`, resolve);
        const relative = Array.isArray(s.points) && s.points.length >= 2 ? s.points : undefined;
        const delta: Point = [num(s.width) ?? DEFAULT_LINE_LENGTH, num(s.height) ?? 0];
        const skel: ExSkeleton = { type: s.type, id, strokeColor: swatch(s.color).stroke };
        let a: EndRef;
        let b: EndRef;
        if (start && end) {
          [a, b] = [start, end];
        } else if (start) {
          [a, b] = [start, offsetFrom(start, delta)];
        } else if (end) {
          [a, b] = [offsetFrom(end, [-delta[0], -delta[1]]), end];
        } else if (relative) {
          const origin: Point = hasPoint(s) ? [s.x!, s.y!] : place(spanOf(relative));
          Object.assign(skel, { x: origin[0], y: origin[1], points: relative.map((p) => [p[0], p[1]]) });
          [a, b] = [{ point: add(origin, relative[0]) }, { point: add(origin, relative[relative.length - 1]) }];
        } else {
          const origin: Point = hasPoint(s) ? [s.x!, s.y!] : place(delta[0]);
          [a, b] = [{ point: origin }, { point: add(origin, delta) }];
        }
        if (s.label && s.type === 'arrow') skel.label = { text: s.label, strokeColor: TEXT_COLOR, fontFamily: TEXT_FONT };
        plan.linear.push({ id, type: s.type, skel, start: a, end: b, frameId });
        break;
      }
    }
  }
  // An empty frame with no geometry gets a default size in the row.
  for (const f of plan.frames) {
    const hasChildren = [...plan.shapes, ...plan.linear].some((c) => c.frameId === f.id);
    if (f.placed || hasChildren) continue;
    const [x, y] = place(DEFAULT_FRAME.width);
    Object.assign(f.skel, { x, y, ...DEFAULT_FRAME });
    f.placed = true;
  }
  return plan;
}

function endRef(
  e: Skeleton['start'],
  where: string,
  resolve: (ref: string, what: string) => string,
): EndRef | undefined {
  if (e === undefined) return undefined;
  if (e && typeof e === 'object' && 'id' in e && typeof e.id === 'string') {
    return { id: resolve(e.id, where) };
  }
  if (e && typeof e === 'object' && 'x' in e && num(e.x) !== undefined && num(e.y) !== undefined) {
    return { point: [e.x, e.y] };
  }
  throw badRequest(`${where}: expected {id} or {x, y}`);
}

function isFrame(
  id: string,
  skeletons: Skeleton[],
  idMap: Map<string, string>,
  ctx: PlanContext,
): boolean {
  const existing = ctx.existing.get(id);
  if (existing) return existing.type === 'frame' || existing.type === 'magicframe';
  return skeletons.some((s) => s.type === 'frame' && s.id !== undefined && idMap.get(s.id) === id);
}

function offsetFrom(ref: EndRef, delta: Point): EndRef {
  if ('point' in ref) return { point: add(ref.point, delta) };
  if ('id' in ref) return { beside: ref.id, delta };
  return ref;
}

function spanOf(points: readonly (readonly [number, number])[]): number {
  const xs = points.map((p) => p[0]);
  return Math.max(...xs) - Math.min(...xs);
}

function hasPoint(s: Skeleton): boolean {
  return num(s.x) !== undefined && num(s.y) !== undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function add(a: Point, b: readonly [number, number]): Point {
  return [a[0] + b[0], a[1] + b[1]];
}

/** Resolves a planned end against real geometry. */
export function endOf(ref: EndRef, lookup: (id: string) => Shaped | undefined): End {
  if ('point' in ref) return { point: ref.point };
  const id = 'id' in ref ? ref.id : ref.beside;
  const shape = lookup(id);
  if (!shape) throw badRequest(`no element with id ${JSON.stringify(id)}`);
  if ('id' in ref) return { shape };
  const [cx, cy] = center(shape);
  const exit = edgePoint(shape, [cx + ref.delta[0], cy + ref.delta[1]]);
  return { point: [exit[0] + ref.delta[0], exit[1] + ref.delta[1]] };
}

/** Position and points of a straight two-point arrow or line between two ends. */
export function linearGeometry(start: End, end: End): { x: number; y: number; points: Point[] } {
  const { from, to } = route(start, end);
  return { x: from[0], y: from[1], points: [[0, 0], [to[0] - from[0], to[1] - from[1]]] };
}
