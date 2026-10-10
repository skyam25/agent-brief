/**
 * Board operations on an Excalidraw scene: draw, update, remove, read and png.
 * Each mutation returns the next element list, which the caller commits as one undo step.
 */

import {
  convertToExcalidrawElements,
  exportToCanvas,
  newElementWith,
} from '@excalidraw/excalidraw';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { BinaryFiles } from '@excalidraw/excalidraw/types';
import type { DeleteRequest, DrawRequest, DrawResponse, MutateResponse, ReadResponse, UpdateRequest } from '../protocol';
import type { Region } from '../server/contract';
import { ARROW_GAP, badgeCentre, boxOf, fitScale, intersects, pad, strokeStart, union, type Box, type Point, type Shaped } from '../board/geometry';
import { STICKY_TEXT, swatch } from '../board/palette';
import { endOf, linearGeometry, planDraw, type EndRef, type ExSkeleton } from '../board/skeleton';
import { metaOf, readScene, type SceneElement } from '../board/summary';

type El = ExcalidrawElement;
/** A fresh element from conversion, safe to edit before it joins the scene. */
type Draft = Record<string, any> & { id: string; type: string; x: number; y: number; width: number; height: number };

const FRAME_PADDING = 30;

export function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (b) => (b % 36).toString(36)).join('');
}

function convert(skeletons: ExSkeleton[], regenerateIds = false): Draft[] {
  return convertToExcalidrawElements(skeletons as never, { regenerateIds }) as unknown as Draft[];
}

const live = (elements: readonly El[]) => elements.filter((e) => !e.isDeleted);

const asScene = (els: readonly El[]) => els as unknown as readonly SceneElement[];

// ── read ─────────────────────────────────────────────────────────────────

export function readElements(
  board: string,
  elements: readonly El[],
  region?: Region,
  firstSeen?: (id: string) => number | undefined,
): ReadResponse {
  return readScene(board, asScene(elements), region, firstSeen);
}

// ── draw ─────────────────────────────────────────────────────────────────

export function drawElements(
  elements: readonly El[],
  req: DrawRequest,
  batchId: string,
  now = Date.now(),
): { next: El[]; response: DrawResponse } {
  const liveEls = live(elements);
  const liveById = new Map(liveEls.map((e) => [e.id, e]));
  const allIds = new Set(elements.map((e) => e.id));
  const plan = planDraw(req?.elements, {
    existing: liveById as unknown as Map<string, Shaped>,
    sceneBounds: union(liveEls.map((e) => boxOf(e as unknown as Shaped))),
    newId: randomId,
    taken: (id) => allIds.has(id),
  });

  const shapes = convert(plan.shapes.map((s) => s.skel));
  const geometry = new Map<string, Shaped>();
  for (const e of liveEls) geometry.set(e.id, e as unknown as Shaped);
  for (const e of shapes) geometry.set(e.id, e as Shaped);

  const frameOf = new Map<string, string>();
  for (const s of plan.shapes) if (s.frameId) frameOf.set(s.id, s.frameId);
  for (const l of plan.linear) if (l.frameId) frameOf.set(l.id, l.frameId);
  // Labels sit in their container's frame.
  for (const d of shapes) if (d.containerId && frameOf.has(d.containerId)) frameOf.set(d.id, frameOf.get(d.containerId)!);

  // Fit unplaced frames to their shapes so arrows can bind to them.
  const fitFrame = (frameId: string, drafts: Draft[]) => {
    const kids = drafts.filter((d) => frameOf.get(d.id) === frameId);
    if (kids.length === 0) return;
    const box = pad(union(kids.map((k) => boxOf(k as Shaped))), FRAME_PADDING);
    const frame = plan.frames.find((f) => f.id === frameId)!;
    Object.assign(frame.skel, box);
    geometry.set(frameId, { type: 'frame', ...box });
  };
  for (const f of plan.frames) {
    if (f.placed) geometry.set(f.id, { type: 'frame', ...(f.skel as unknown as Box) });
    else fitFrame(f.id, shapes);
  }

  const lookup = (id: string) => geometry.get(id);
  const linearSkels = plan.linear.map((l) => {
    if (l.skel.points) return l.skel;
    return { ...l.skel, ...linearGeometry(endOf(l.start, lookup), endOf(l.end, lookup)) };
  });
  const linear = convert(linearSkels);
  for (const d of linear) if (d.containerId && frameOf.has(d.containerId)) frameOf.set(d.id, frameOf.get(d.containerId)!);

  for (const f of plan.frames) if (!f.placed) fitFrame(f.id, [...shapes, ...linear]);
  const frames = convert(plan.frames.map((f) => f.skel));
  // Excalidraw treats a frame at x or y 0 as unset and refits it, so put back the planned box.
  for (const [i, f] of plan.frames.entries()) {
    const { x, y, width, height } = f.skel as unknown as Box;
    Object.assign(frames[i], { x, y, width, height });
  }

  const drafts = [...shapes, ...linear, ...frames];
  const draftById = new Map(drafts.map((d) => [d.id, d]));
  const sticky = new Set(plan.shapes.filter((s) => s.sticky).map((s) => s.id));
  for (const d of drafts) {
    d.customData = { ...(d.customData ?? {}), by: 'claude', batchId, createdAt: now, ...(sticky.has(d.id) ? { kind: 'sticky', sticky: true } : {}) };
    d.frameId = frameOf.get(d.id) ?? null;
    d.index = null;
  }

  // Bind arrow ends to shapes, new or existing.
  const replaced = new Map<string, El>();
  const addBound = (targetId: string, arrowId: string) => {
    const bound = { id: arrowId, type: 'arrow' as const };
    const draft = draftById.get(targetId);
    if (draft) {
      draft.boundElements = [...(draft.boundElements ?? []), bound];
      return;
    }
    const current = replaced.get(targetId) ?? liveById.get(targetId)!;
    replaced.set(targetId, newElementWith(current, { boundElements: [...(current.boundElements ?? []), bound] }));
  };
  for (const l of plan.linear) {
    if (l.type !== 'arrow') continue;
    const arrow = draftById.get(l.id)!;
    for (const [end, key] of [[l.start, 'startBinding'], [l.end, 'endBinding']] as [EndRef, string][]) {
      if (!('id' in end)) continue;
      arrow[key] = { elementId: end.id, focus: 0, gap: ARROW_GAP };
      addBound(end.id, l.id);
    }
  }

  const next = [...elements.map((e) => replaced.get(e.id) ?? e), ...(drafts as unknown as El[])];
  return { next, response: { ids: plan.ids, batchId } };
}

// ── update ───────────────────────────────────────────────────────────────

const CONTAINERS = new Set(['rectangle', 'ellipse', 'diamond', 'arrow']);

/** Measures and places `text` inside `container` the way Excalidraw lays out labels. */
function layoutLabel(container: Draft, text: string, textEl: El | undefined) {
  const t = textEl as Draft | undefined;
  const skel: ExSkeleton = {
    type: container.type,
    id: 'measure',
    x: container.x,
    y: container.y,
    width: container.width,
    height: container.height,
    ...(container.points ? { points: container.points } : {}),
    label: {
      text,
      strokeColor: t?.strokeColor ?? container.strokeColor,
      ...(t ? { fontSize: t.fontSize, fontFamily: t.fontFamily } : {}),
    },
  };
  const [c, label] = convert([skel], true);
  const { x, y, width, height, fontSize, fontFamily, lineHeight } = label;
  return {
    containerHeight: c.height as number,
    text: { x, y, width, height, fontSize, fontFamily, lineHeight, text: label.text, originalText: text },
  };
}

function measureText(el: El, text: string) {
  const t = el as Draft;
  const [m] = convert(
    [{ type: 'text', id: 'measure', x: t.x, y: t.y, text, fontSize: t.fontSize, fontFamily: t.fontFamily }],
    true,
  );
  return { text: m.text, originalText: text, width: m.width, height: m.height };
}

export function updateElements(
  elements: readonly El[],
  req: UpdateRequest,
  batchId: string,
): { next: El[]; response: MutateResponse } {
  const byId = new Map(live(elements).map((e) => [e.id, e]));
  const changed = new Map<string, Draft>();
  const get = (id: string) => (changed.get(id) ?? byId.get(id)) as Draft | undefined;
  const set = (id: string, patch: Record<string, unknown>) => {
    const cur = get(id);
    if (cur) changed.set(id, { ...cur, ...patch });
  };
  const created: Draft[] = [];
  const touched = new Set<string>();
  const ids: string[] = [];

  for (const u of req?.updates ?? []) {
    const el = get(u.id);
    if (!el || (el.type === 'text' && el.containerId)) continue;
    ids.push(u.id);
    const dx = u.x !== undefined ? u.x - el.x : 0;
    const dy = u.y !== undefined ? u.y - el.y : 0;
    const patch: Record<string, unknown> = {};
    if (dx || dy) Object.assign(patch, { x: el.x + dx, y: el.y + dy });
    if (u.width !== undefined && !el.points) patch.width = u.width;
    if (u.height !== undefined && !el.points) patch.height = u.height;
    if (u.color) {
      const s = swatch(u.color);
      if (metaOf(el as SceneElement).kind === 'sticky') Object.assign(patch, { backgroundColor: s.fill, strokeColor: s.stroke });
      else patch.strokeColor = s.stroke;
    }
    if (u.label !== undefined && el.type === 'frame') patch.name = u.label;
    if (u.label !== undefined && el.type === 'text') Object.assign(patch, measureText(el as El, u.label));
    set(u.id, patch);
    touched.add(u.id);

    // Moving a frame moves what is in it.
    if (el.type === 'frame' && (dx || dy)) {
      for (const child of byId.values()) {
        if (child.frameId !== el.id) continue;
        const c = get(child.id)!;
        set(child.id, { x: c.x + dx, y: c.y + dy });
        touched.add(child.id);
      }
    }

    // Labels follow their container.
    if (CONTAINERS.has(el.type)) {
      const container = get(u.id)!;
      const textRef = container.boundElements?.find((b: { type: string }) => b.type === 'text');
      const textEl = textRef ? (get(textRef.id) as El | undefined) : undefined;
      const text = u.label ?? (textEl as Draft | undefined)?.originalText;
      if (text !== undefined && (textEl || u.label)) {
        const laid = layoutLabel(container, text, textEl);
        if (!container.points && laid.containerHeight > container.height) set(u.id, { height: laid.containerHeight });
        if (textEl) {
          set(textEl.id, { ...laid.text, ...(u.color && metaOf(el as SceneElement).kind !== 'sticky' ? { strokeColor: swatch(u.color).stroke } : {}) });
        } else {
          const id = randomId();
          const isSticky = metaOf(el as SceneElement).kind === 'sticky';
          const [fresh] = convert([{ type: 'text', id, x: laid.text.x, y: laid.text.y, text }]);
          created.push({
            ...fresh,
            ...laid.text,
            containerId: u.id,
            frameId: container.frameId ?? null,
            textAlign: 'center',
            verticalAlign: 'middle',
            strokeColor: isSticky ? STICKY_TEXT : container.strokeColor,
            customData: { by: 'claude', batchId, createdAt: Date.now() },
            index: null,
          });
          set(u.id, { boundElements: [...(container.boundElements ?? []), { id, type: 'text' }] });
        }
      }
    }
  }

  // Re-route arrows bound to anything that moved or changed size.
  const geometry = (id: string) => get(id) as Shaped | undefined;
  for (const el of byId.values()) {
    if (el.type !== 'arrow' || touched.has(el.id)) continue;
    const a = el as Draft;
    const s = a.startBinding?.elementId as string | undefined;
    const e = a.endBinding?.elementId as string | undefined;
    if (!(s && touched.has(s)) && !(e && touched.has(e))) continue;
    const pts = a.points as [number, number][];
    const startEnd = s && geometry(s) ? { shape: geometry(s)! } : { point: [a.x + pts[0][0], a.y + pts[0][1]] as [number, number] };
    const last = pts[pts.length - 1];
    const endEnd = e && geometry(e) ? { shape: geometry(e)! } : { point: [a.x + last[0], a.y + last[1]] as [number, number] };
    const g = linearGeometry(startEnd, endEnd);
    set(el.id, { ...g, width: Math.abs(g.points[1][0]), height: Math.abs(g.points[1][1]) });
    const label = a.boundElements?.find((b: { type: string }) => b.type === 'text');
    const labelEl = label ? (get(label.id) as El | undefined) : undefined;
    if (labelEl) set(labelEl.id, layoutLabel(get(el.id)!, (labelEl as Draft).originalText, labelEl).text);
  }

  const next = [
    ...elements.map((e) => {
      const c = changed.get(e.id);
      if (!c) return e;
      const { id: _id, version: _v, versionNonce: _n, updated: _u, ...patch } = c;
      return newElementWith(e, patch as never);
    }),
    ...(created as unknown as El[]),
  ];
  return { next, response: { ids, batchId } };
}

// ── remove ───────────────────────────────────────────────────────────────

export function removeElements(
  elements: readonly El[],
  req: DeleteRequest,
  batchId: string,
): { next: El[]; response: MutateResponse } {
  const byId = new Map(live(elements).map((e) => [e.id, e]));
  const ids = (req?.ids ?? []).filter((id) => byId.has(id));
  const doomed = new Set<string>();
  const doom = (id: string) => {
    if (doomed.has(id) || !byId.has(id)) return;
    doomed.add(id);
    const el = byId.get(id)!;
    for (const b of el.boundElements ?? []) if (b.type === 'text') doom(b.id);
    if (el.type === 'frame') for (const c of byId.values()) if (c.frameId === id) doom(c.id);
  };
  ids.forEach(doom);

  const next = elements.map((e) => {
    if (doomed.has(e.id)) return newElementWith(e, { isDeleted: true });
    if (e.isDeleted) return e;
    const patch: Record<string, unknown> = {};
    const a = e as Draft;
    if (a.startBinding && doomed.has(a.startBinding.elementId)) patch.startBinding = null;
    if (a.endBinding && doomed.has(a.endBinding.elementId)) patch.endBinding = null;
    if (e.boundElements?.some((b) => doomed.has(b.id))) {
      patch.boundElements = e.boundElements.filter((b) => !doomed.has(b.id));
    }
    return Object.keys(patch).length ? newElementWith(e, patch as never) : e;
  });
  return { next, response: { ids, batchId } };
}

// ── png ──────────────────────────────────────────────────────────────────

const EXPORT_PADDING = 24;

/**
 * PNG of the live elements, or of `region` only, with the long edge at most
 * `maxEdge`. Exports for Claude are always light with a white background,
 * whatever theme the panel shows. `numbers` writes small stroke numbers and
 * image letters next to those elements, matching the labels in timeline.md.
 */
export async function renderPng(
  elements: readonly El[],
  files: BinaryFiles,
  opts: { region?: Region; maxEdge: number; numbers?: Record<string, number | string> },
): Promise<Uint8Array> {
  const els = live(elements);
  const appState = { exportBackground: true, viewBackgroundColor: '#ffffff', exportWithDarkMode: false };
  const numbered = opts.numbers && Object.keys(opts.numbers).length > 0 ? opts.numbers : undefined;
  // Numbers need a known origin, so a numbered whole-board export crops to the padded scene box.
  const region =
    opts.region ??
    (numbered && els.length > 0
      ? pad(union(els.map((e) => boxOf(e as unknown as Shaped))), BADGE_ROOM, BADGE_ROOM + FRAME_NAME_ROOM)
      : undefined);
  let canvas: HTMLCanvasElement;
  if (region) {
    canvas = await renderRegion(els, files, region, opts.maxEdge);
    if (numbered) drawNumbers(canvas, els, numbered, region, fitScale(region.width, region.height, opts.maxEdge));
  } else if (els.length === 0) {
    canvas = whiteCanvas(Math.min(400, opts.maxEdge), Math.min(300, opts.maxEdge));
  } else {
    canvas = await exportToCanvas({
      elements: els,
      appState,
      files,
      exportPadding: EXPORT_PADDING,
      getDimensions: (width: number, height: number) => {
        const scale = fitScale(width, height, opts.maxEdge);
        return {
          width: Math.max(1, Math.floor(width * scale)),
          height: Math.max(1, Math.floor(height * scale)),
          scale,
        };
      },
    });
  }
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG export failed'))), 'image/png'),
  );
  return new Uint8Array(await blob.arrayBuffer());
}

/** Room around a numbered export for badges, which sit outside stroke starts. */
const BADGE_ROOM = 44;

/** Room above the scene for frame names, which sit outside their frames. */
const FRAME_NAME_ROOM = 24;

/** Badge text height in output pixels, readable after the 1400 px cap. */
const BADGE_FONT_PX = 13;

/**
 * Writes each stroke's number in a dark badge just outside where the stroke
 * starts, so it sits next to the ink, not on it. Sizes are in output pixels.
 */
function drawNumbers(
  canvas: HTMLCanvasElement,
  els: El[],
  numbers: Record<string, number | string>,
  region: Region,
  scale: number,
): void {
  const ctx = canvas.getContext('2d')!;
  ctx.font = `700 ${BADGE_FONT_PX}px -apple-system, Helvetica, sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  const toCanvas = ([x, y]: Point): Point => [(x - region.x) * scale, (y - region.y) * scale];
  for (const el of els) {
    const n = numbers[el.id];
    if (n === undefined) continue;
    const label = String(n);
    const h = BADGE_FONT_PX + 8;
    const w = Math.max(h, ctx.measureText(label).width + 10);
    const { start, along } = strokeStart(el as unknown as Shaped);
    const inkRadius = ((el.strokeWidth ?? 2) * 2.2 + 1) * scale;
    let [cx, cy] = badgeCentre(toCanvas(start), toCanvas(along), Math.max(w, h) / 2, inkRadius + 3);
    cx = Math.min(Math.max(cx, w / 2 + 1), canvas.width - w / 2 - 1);
    cy = Math.min(Math.max(cy, h / 2 + 1), canvas.height - h / 2 - 1);
    ctx.beginPath();
    ctx.roundRect(cx - w / 2, cy - h / 2, w, h, h / 2);
    ctx.fillStyle = '#1e1e1e';
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.fillText(label, cx, cy + 0.5);
  }
}

function whiteCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  return canvas;
}

/** How far the export anchor sits outside everything, so frame names above frames never push past it. */
const ANCHOR_MARGIN = 200;

/** Exports the elements touching `region`, then crops to it. */
async function renderRegion(els: El[], files: BinaryFiles, region: Region, maxEdge: number): Promise<HTMLCanvasElement> {
  const scale = fitScale(region.width, region.height, maxEdge);
  const out = whiteCanvas(Math.max(1, Math.floor(region.width * scale)), Math.max(1, Math.floor(region.height * scale)));
  const touching = els.filter((e) => intersects(boxOf(e as unknown as Shaped), region));
  if (touching.length === 0) return out;
  const all = union([region, ...touching.map((e) => boxOf(e as unknown as Shaped))]);
  // Two invisible anchors, up-left and down-right of everything, fix the export's
  // origin and keep stroke edges past the last point from being cut off.
  const anchorAt = (x: number, y: number): ExSkeleton => ({
    type: 'rectangle',
    id: `anchor-${randomId()}`,
    x,
    y,
    width: 1,
    height: 1,
    opacity: 0,
    strokeColor: 'transparent',
    backgroundColor: 'transparent',
  });
  const [anchor, farAnchor] = convert([
    anchorAt(all.x - ANCHOR_MARGIN, all.y - ANCHOR_MARGIN),
    anchorAt(all.x + all.width + ANCHOR_MARGIN, all.y + all.height + ANCHOR_MARGIN),
  ]);
  const full = await exportToCanvas({
    elements: [anchor as unknown as El, ...touching, farAnchor as unknown as El],
    appState: { exportBackground: true, viewBackgroundColor: '#ffffff', exportWithDarkMode: false },
    files,
    exportPadding: 0,
    getDimensions: (width: number, height: number) => ({
      width: Math.ceil(width * scale),
      height: Math.ceil(height * scale),
      scale,
    }),
  });
  out
    .getContext('2d')!
    .drawImage(
      full,
      (region.x - anchor.x) * scale,
      (region.y - anchor.y) * scale,
      out.width,
      out.height,
      0,
      0,
      out.width,
      out.height,
    );
  return out;
}
