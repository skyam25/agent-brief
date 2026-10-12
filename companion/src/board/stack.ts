/**
 * The Stack layout: screenshots in numbered groups, one group per row, newest
 * at the bottom. Each group is a frame. Pure, so the renderer and main share it.
 */

import type { BoardLayout } from '../protocol';
import { boxOf, type Box, type Shaped } from './geometry';

/** A stack board's scene file carries `"agentBrief": { "layout": "stack" }` beside Excalidraw's fields. */
export function layoutOfScene(scene: unknown): BoardLayout {
  const meta = (scene as { agentBrief?: { layout?: unknown } } | null)?.agentBrief;
  return meta?.layout === 'stack' ? 'stack' : 'freeform';
}

/** The scene with its layout set. A freeform scene carries no marker. */
export function withLayout<T extends object>(scene: T, layout: BoardLayout): T {
  const { agentBrief: _drop, ...rest } = scene as T & { agentBrief?: unknown };
  return (layout === 'stack' ? { ...rest, agentBrief: { layout } } : rest) as T;
}

/** The fields the layout reads from an Excalidraw element. */
export interface StackElement extends Shaped {
  id: string;
  isDeleted?: boolean;
  frameId?: string | null;
  containerId?: string | null;
  name?: string | null;
  customData?: Record<string, unknown>;
}

/** Changes the layout makes to one element. */
export interface StackPatch {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  frameId?: string | null;
  name?: string;
  isDeleted?: boolean;
  customData?: Record<string, unknown>;
}

export interface NewFrame {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  name: string;
  customData: { stack: { index: number } };
}

export interface StackPlan {
  patches: Map<string, StackPatch>;
  frames: NewFrame[];
}

/** Images that just arrived in one drop or paste. They join `join`, or share one new group. */
export interface Arrival {
  ids: string[];
  join?: string;
}

/** Largest box a screenshot gets when it joins the stack. */
export const CELL = { width: 480, height: 360 };
export const PER_ROW = 3;
const PAD = 24;
const GAP = 24;
/** Space between groups, which also holds the frame name above each frame. */
const GROUP_GAP = 64;
/** Excalidraw refits a frame at x or y 0, so the stack starts clear of the origin. */
const ORIGIN = { x: 40, y: 40 };
const EPSILON = 0.01;

interface StackData {
  index?: number;
  order?: number;
}

const stackOf = (e: StackElement): StackData | undefined => {
  const s = e.customData?.stack;
  return s && typeof s === 'object' ? (s as StackData) : undefined;
};

export const isStackFrame = (e: StackElement): boolean => e.type === 'frame' && typeof stackOf(e)?.index === 'number';

const contains = (b: Box, x: number, y: number) => x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height;

const centerOf = (e: StackElement): [number, number] => [e.x + e.width / 2, e.y + e.height / 2];

function overlapArea(a: Box, b: Box): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/** Scales a picture down to fit CELL. Smaller pictures keep their size. */
export function fitCell(width: number, height: number): { width: number; height: number } {
  if (width <= 0 || height <= 0) return { width: CELL.width, height: CELL.height };
  const scale = Math.min(1, CELL.width / width, CELL.height / height);
  return { width: width * scale, height: height * scale };
}

interface Group {
  /** The existing frame, or the id a new one gets. */
  id: string;
  existing?: StackElement;
  index: number;
  members: { el: StackElement; order: number }[];
}

/**
 * Where every screenshot, group frame and annotation belongs.
 *
 * An image joins the group whose frame holds its centre. An image outside every
 * frame starts a group of its own. Images inside other frames, such as Claude's
 * `snap` steps, stay where they are. Marks drawn over a screenshot move with it.
 */
export function planStack(elements: readonly StackElement[], opts: { arrival?: Arrival; newId: () => string }): StackPlan {
  const live = elements.filter((e) => !e.isDeleted);
  const byId = new Map(live.map((e) => [e.id, e]));
  const frames = live.filter(isStackFrame).sort((a, b) => stackOf(a)!.index! - stackOf(b)!.index!);
  const otherFrames = live.filter((e) => e.type === 'frame' && !isStackFrame(e));
  const arriving = new Set(opts.arrival?.ids ?? []);

  let nextIndex = Math.max(0, ...frames.map((f) => stackOf(f)!.index!)) + 1;
  let nextOrder = Math.max(0, ...live.filter((e) => e.type === 'image').map((e) => stackOf(e)?.order ?? 0)) + 1;

  const groups = new Map<string, Group>(frames.map((f) => [f.id, { id: f.id, existing: f, index: stackOf(f)!.index!, members: [] }]));
  const fresh = (): Group => {
    const g = { id: opts.newId(), index: nextIndex++, members: [] };
    groups.set(g.id, g);
    return g;
  };

  for (const img of live) {
    if (img.type !== 'image' || arriving.has(img.id)) continue;
    const [cx, cy] = centerOf(img);
    const own = img.frameId ? groups.get(img.frameId) : undefined;
    const target =
      own && contains(own.existing!, cx, cy) ? own : frames.map((f) => groups.get(f.id)!).find((g) => contains(g.existing!, cx, cy));
    if (target) {
      const order = target === own ? (stackOf(img)?.order ?? nextOrder++) : nextOrder++;
      target.members.push({ el: img, order });
      continue;
    }
    const inOther = otherFrames.some((f) => f.id === img.frameId || contains(f, cx, cy));
    if (!inOther) fresh().members.push({ el: img, order: nextOrder++ });
  }

  if (opts.arrival?.ids.length) {
    const join = opts.arrival.join ? groups.get(opts.arrival.join) : undefined;
    const target = join ?? fresh();
    for (const id of opts.arrival.ids) {
      const el = byId.get(id);
      if (el) target.members.push({ el, order: nextOrder++ });
    }
  }

  const patches = new Map<string, StackPatch>();
  const patch = (el: StackElement, p: StackPatch) => {
    const changed: StackPatch = {};
    for (const [k, v] of Object.entries(p) as [keyof StackPatch, unknown][]) {
      const cur = (el as unknown as Record<string, unknown>)[k];
      const same = typeof v === 'number' && typeof cur === 'number' ? Math.abs(v - cur) < EPSILON : k === 'customData' ? sameStack(el, v) : cur === v || (cur == null && v == null);
      if (!same) (changed as Record<string, unknown>)[k] = v;
    }
    if (Object.keys(changed).length) patches.set(el.id, { ...patches.get(el.id), ...changed });
  };

  const newFrames: NewFrame[] = [];
  /** Old and new box of each placed image, for the marks drawn on it. */
  const moved = new Map<string, { from: Box; to: Box; frameId: string }>();
  const frameMove = new Map<string, { dx: number; dy: number }>();
  const ordered = [...groups.values()].filter((g) => g.members.length > 0).sort((a, b) => a.index - b.index);

  let top = ORIGIN.y;
  ordered.forEach((g, gi) => {
    const members = g.members.sort((a, b) => a.order - b.order);
    const sizes = members.map(({ el }) => (stackOf(el)?.order === undefined ? fitCell(el.width, el.height) : { width: el.width, height: el.height }));
    let y = top + PAD;
    let innerWidth = 0;
    for (let r = 0; r < members.length; r += PER_ROW) {
      const row = sizes.slice(r, r + PER_ROW);
      let x = ORIGIN.x + PAD;
      row.forEach((s, i) => {
        const { el, order } = members[r + i];
        const to = { x, y, width: s.width, height: s.height };
        moved.set(el.id, { from: boxOf(el), to, frameId: g.id });
        patch(el, { ...to, frameId: g.id, customData: { ...el.customData, stack: { order } } });
        x += s.width + GAP;
      });
      innerWidth = Math.max(innerWidth, x - GAP - (ORIGIN.x + PAD));
      y += Math.max(...row.map((s) => s.height)) + GAP;
    }
    const box = { x: ORIGIN.x, y: top, width: innerWidth + PAD * 2, height: y - GAP + PAD - top };
    const name = String(gi + 1);
    if (g.existing) {
      frameMove.set(g.id, { dx: box.x - g.existing.x, dy: box.y - g.existing.y });
      patch(g.existing, { ...box, name });
    } else {
      newFrames.push({ id: g.id, ...box, name, customData: { stack: { index: g.index } } });
    }
    top += box.height + GROUP_GAP;
  });

  for (const f of frames) if (!ordered.some((g) => g.id === f.id)) patches.set(f.id, { isDeleted: true });
  const gone = new Set(frames.filter((f) => patches.get(f.id)?.isDeleted).map((f) => f.id));

  // Marks drawn over a screenshot move with it. Other marks in a group move with its frame.
  const follow = new Map<string, { dx: number; dy: number; frameId?: string | null }>();
  for (const el of live) {
    if (el.type === 'image' || el.type === 'frame' || el.containerId) continue;
    const box = boxOf(el);
    let best: { from: Box; to: Box; frameId: string } | undefined;
    let bestArea = 0;
    for (const m of moved.values()) {
      const area = overlapArea(box, m.from);
      if (area > bestArea) [best, bestArea] = [m, area];
    }
    // A mark already in a group goes to its picture's group. A mark outside every frame stays outside.
    const inGroup = !!el.frameId && groups.has(el.frameId);
    if (best) follow.set(el.id, { dx: best.to.x - best.from.x, dy: best.to.y - best.from.y, ...(inGroup ? { frameId: best.frameId } : {}) });
    else if (el.frameId && frameMove.has(el.frameId)) follow.set(el.id, frameMove.get(el.frameId)!);
    else if (el.frameId && gone.has(el.frameId)) follow.set(el.id, { dx: 0, dy: 0, frameId: null });
  }
  // Labels go where their container goes.
  for (const el of live) {
    if (!el.containerId || !follow.has(el.containerId)) continue;
    follow.set(el.id, follow.get(el.containerId)!);
  }
  for (const [id, f] of follow) {
    const el = byId.get(id)!;
    patch(el, { x: el.x + f.dx, y: el.y + f.dy, ...(f.frameId !== undefined ? { frameId: f.frameId } : {}) });
  }

  return { patches, frames: newFrames };
}

function sameStack(el: StackElement, next: unknown): boolean {
  const a = stackOf(el);
  const b = (next as { stack?: StackData } | undefined)?.stack;
  return a?.order === b?.order && a?.index === b?.index;
}

export const planIsEmpty = (plan: StackPlan): boolean => plan.patches.size === 0 && plan.frames.length === 0;

/**
 * Names for the screenshots in stack groups: `2` for a group's only picture,
 * `2a`, `2b` and so on when it holds more.
 */
export function stackNames(elements: readonly StackElement[]): Record<string, string> {
  const live = elements.filter((e) => !e.isDeleted);
  const frames = live.filter(isStackFrame).sort((a, b) => stackOf(a)!.index! - stackOf(b)!.index!);
  const names: Record<string, string> = {};
  let n = 0;
  for (const f of frames) {
    const members = live
      .filter((e) => e.type === 'image' && e.frameId === f.id)
      .sort((a, b) => (stackOf(a)?.order ?? 0) - (stackOf(b)?.order ?? 0));
    if (members.length === 0) continue;
    n++;
    members.forEach((m, i) => (names[m.id] = members.length === 1 ? String(n) : `${n}${String.fromCharCode(97 + (i % 26))}`));
  }
  return names;
}
