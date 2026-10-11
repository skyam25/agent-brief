import type { ElementSummary, ReadResponse, ShapeType } from '../protocol';
import { boxOf, intersects, union, type Box } from './geometry';
import { colorNameOf } from './palette';

/** The fields a summary needs from an Excalidraw element. */
export interface SceneElement {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  isDeleted?: boolean;
  points?: readonly (readonly [number, number])[];
  text?: string;
  originalText?: string;
  name?: string | null;
  containerId?: string | null;
  boundElements?: readonly { id: string; type: string }[] | null;
  frameId?: string | null;
  startBinding?: { elementId: string } | null;
  endBinding?: { elementId: string } | null;
  strokeColor?: string;
  backgroundColor?: string;
  customData?: Record<string, unknown>;
}

export interface ElementMeta {
  by: 'user' | 'claude';
  batchId?: string;
  createdAt?: number;
  kind?: 'sticky';
}

export function metaOf(el: SceneElement): ElementMeta {
  const c = el.customData ?? {};
  return {
    by: c.by === 'claude' ? 'claude' : 'user',
    batchId: typeof c.batchId === 'string' ? c.batchId : undefined,
    createdAt: typeof c.createdAt === 'number' ? c.createdAt : undefined,
    kind: c.kind === 'sticky' ? 'sticky' : undefined,
  };
}

const TYPE_MAP: Record<string, ShapeType> = {
  rectangle: 'rectangle',
  ellipse: 'ellipse',
  diamond: 'diamond',
  text: 'text',
  arrow: 'arrow',
  line: 'line',
  frame: 'frame',
  magicframe: 'frame',
  freedraw: 'freedraw',
  image: 'image',
  iframe: 'rectangle',
  embeddable: 'rectangle',
};

/** True for text that sits inside a shape. It reads back as the shape's label. */
export function isLabel(el: SceneElement, byId: ReadonlyMap<string, SceneElement>): boolean {
  if (el.type !== 'text' || !el.containerId) return false;
  const container = byId.get(el.containerId);
  return !!container && !container.isDeleted;
}

export function labelOf(el: SceneElement, byId: ReadonlyMap<string, SceneElement>): string | undefined {
  if (el.type === 'text') return el.originalText ?? el.text;
  if (el.type === 'frame' || el.type === 'magicframe') return el.name ?? undefined;
  const textRef = el.boundElements?.find((b) => b.type === 'text');
  const text = textRef ? byId.get(textRef.id) : undefined;
  if (text && !text.isDeleted) return text.originalText ?? text.text;
  return undefined;
}

export function summarize(
  el: SceneElement,
  byId: ReadonlyMap<string, SceneElement>,
  firstSeen?: (id: string) => number | undefined,
): ElementSummary {
  const meta = metaOf(el);
  const box = boxOf(el);
  const sticky = meta.kind === 'sticky';
  const out: ElementSummary = {
    id: el.id,
    type: sticky ? 'sticky' : (TYPE_MAP[el.type] ?? 'rectangle'),
    x: round(box.x),
    y: round(box.y),
    width: round(box.width),
    height: round(box.height),
    by: meta.by,
  };
  const label = labelOf(el, byId);
  if (label !== undefined && label !== '') out.label = label;
  const color = sticky ? el.backgroundColor : el.strokeColor;
  if (color && color !== 'transparent') out.color = colorNameOf(color) ?? color;
  if (el.frameId) out.frameId = el.frameId;
  if (el.startBinding?.elementId) out.startId = el.startBinding.elementId;
  if (el.endBinding?.elementId) out.endId = el.endBinding.elementId;
  const createdAt = meta.createdAt ?? firstSeen?.(el.id);
  if (createdAt !== undefined) out.createdAt = createdAt;
  return out;
}

/** Summaries of live elements, filtered to those touching `region`, plus the whole scene's bounds. */
export function readScene(
  board: string,
  elements: readonly SceneElement[],
  region?: Box,
  firstSeen?: (id: string) => number | undefined,
): ReadResponse {
  const live = elements.filter((e) => !e.isDeleted && e.type !== 'selection');
  const byId = new Map(live.map((e) => [e.id, e]));
  const listed = live.filter((e) => !isLabel(e, byId) && (!region || intersects(boxOf(e), region)));
  const b = union(live.map(boxOf));
  return {
    board,
    elements: listed.map((e) => summarize(e, byId, firstSeen)),
    bounds: { x: round(b.x), y: round(b.y), width: round(b.width), height: round(b.height) },
  };
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}
