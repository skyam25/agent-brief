/**
 * Board operations on an Excalidraw scene: draw, update, remove and read.
 * Each mutation returns the next element list, which the caller commits as one undo step.
 */

import { convertToExcalidrawElements, newElementWith } from '@excalidraw/excalidraw';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { DeleteRequest, DrawRequest, DrawResponse, MutateResponse, ReadResponse, UpdateRequest } from '../protocol';
import type { Region } from '../server/contract';
import { ARROW_GAP, boxOf, pad, union, type Box, type Shaped } from '../board/geometry';
import { TEXT_COLOR, TEXT_FONT, swatch } from '../board/palette';
import { endOf, linearGeometry, planDraw, type EndRef, type ExSkeleton, type PlannedFile } from '../board/skeleton';
import { metaOf, readScene, summarize, type SceneElement } from '../board/summary';

type El = ExcalidrawElement;
/** A fresh element from conversion, safe to edit before it joins the scene. */
type Draft = Record<string, any> & { id: string; type: string; x: number; y: number; width: number; height: number };

const FRAME_PADDING = 30;

/** Room between a box's edge and its label, on every side. Excalidraw keeps 5 at the sides itself. */
const LABEL_PADDING = 16;
const EXCALIDRAW_LABEL_PADDING = 5;

/** Line an arrow must show on each side of its label. */
const LABEL_CLEARANCE = 20;

/** Room a move suggestion leaves below an element, and below a frame for the next frame's title. */
const MOVE_GAP = 20;
const FRAME_MOVE_GAP = 40;

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
): { next: El[]; response: DrawResponse; files: PlannedFile[] } {
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
  // A box keeps LABEL_PADDING around its label, and grows to hold it.
  const plannedHeight = new Map(plan.shapes.map((s) => [s.id, s.skel.height as number]));
  for (const t of shapes) {
    const c = t.containerId ? shapes.find((d) => d.id === t.containerId) : undefined;
    if (t.type !== 'text' || !c) continue;
    const laid = layoutLabel(c, t.originalText, t as unknown as El, plannedHeight.get(c.id));
    c.height = laid.containerHeight;
    Object.assign(t, laid.text);
  }
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
  // A placed frame grows to hold children that outgrew it, as a box does for its label.
  const grown = new Set<string>();
  const growFrame = (frameId: string, box: Box): Box => {
    const kids = shapes.filter((d) => frameOf.get(d.id) === frameId);
    if (kids.length === 0) return box;
    const next = union([box, pad(union(kids.map((k) => boxOf(k as Shaped))), FRAME_PADDING)]);
    if (next.x === box.x && next.y === box.y && next.width === box.width && next.height === box.height) return box;
    grown.add(frameId);
    return next;
  };
  for (const f of plan.frames) {
    if (f.placed) {
      Object.assign(f.skel, growFrame(f.id, f.skel as unknown as Box));
      geometry.set(f.id, { type: 'frame', ...(f.skel as unknown as Box) });
    } else fitFrame(f.id, shapes);
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

  // Frames already on the board grow too.
  for (const frameId of new Set(frameOf.values())) {
    const frame = liveById.get(frameId);
    if (!frame || frame.type !== 'frame') continue;
    const current = replaced.get(frameId) ?? frame;
    const box = growFrame(frameId, current as unknown as Box);
    if (grown.has(frameId)) replaced.set(frameId, newElementWith(current, box));
  }

  const next = [...elements.map((e) => replaced.get(e.id) ?? e), ...(drafts as unknown as El[])];

  // Free text has no planned size, so only boxed shapes can grow.
  const sized = plan.shapes.filter((s) => typeof s.skel.height === 'number');
  const before = new Map(sized.map((s) => [s.id, s.skel as unknown as Box]));
  const warnings = [...hiddenArrows(linear), ...grownShapes(before, next), ...grownFrames(grown, next)];
  const scene = asScene(live(next));
  const sceneById = new Map(scene.map((e) => [e.id, e]));
  const summaries = plan.ids.map((id) => summarize(sceneById.get(id)!, sceneById));
  const response: DrawResponse = { ids: plan.ids, batchId, elements: summaries, ...(warnings.length ? { warnings } : {}) };
  return { next, response, files: plan.files };
}

const boxOfEl = (e: El) => boxOf(e as unknown as Shaped);

/** True when the boxes share area. Boxes that only touch do not overlap. */
const overlaps = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** How far `hits` must move to clear `box` by `gap`, as "down at least 26 px". */
function clearance(box: Box, hits: Box[], gap: number): string {
  if (hits.every((h) => h.y >= box.y)) {
    return `down at least ${Math.ceil(Math.max(...hits.map((h) => box.y + box.height + gap - h.y)))} px`;
  }
  return `right at least ${Math.ceil(Math.max(...hits.map((h) => box.x + box.width + gap - h.x)))} px`;
}

const them = (ids: string[]) => (ids.length === 1 ? ids[0] : ids.join(', '));

/**
 * Shapes that grew taller to hold their label, and what they now cover that
 * their planned box did not. A shape in a frame leaves frames to grownFrames.
 */
function grownShapes(before: ReadonlyMap<string, Box>, elements: readonly El[]): string[] {
  const scene = live(elements);
  const byId = new Map(scene.map((e) => [e.id, e]));
  const solid = scene.filter((e) => !(e.type === 'text' && e.containerId) && e.type !== 'arrow' && e.type !== 'line');
  const warnings: string[] = [];
  for (const [id, planned] of before) {
    const el = byId.get(id);
    if (!el) continue;
    const box = boxOfEl(el);
    if (box.height <= planned.height) continue;
    const hit = solid.filter((o) => {
      if (o.id === id || (el.frameId && o.type === 'frame')) return false;
      const b = boxOfEl(o);
      return b.y >= box.y && overlaps(box, b) && !overlaps(planned, b);
    });
    if (hit.length === 0) continue;
    const kind = metaOf(el as unknown as SceneElement).kind === 'sticky' ? 'sticky' : el.type;
    const ids = hit.map((h) => h.id);
    warnings.push(
      `${kind} ${id} grew from ${Math.round(planned.height)} to ${Math.round(box.height)} px tall to hold its label and now overlaps ${them(ids)}. ` +
        `Move ${ids.length === 1 ? 'it' : 'them'} ${clearance(box, hit.map(boxOfEl), MOVE_GAP)} with update, or give ${id} more width.`,
    );
  }
  return warnings;
}

/** Frames that grew to hold their contents, and other frames they now overlap. */
function grownFrames(grown: Set<string>, elements: readonly El[]): string[] {
  const frames = live(elements).filter((e) => e.type === 'frame');
  return [...grown].map((id) => {
    const frame = frames.find((f) => f.id === id)!;
    const box = boxOfEl(frame);
    const hit = frames.filter((f) => f.id !== id && overlaps(box, boxOfEl(f)));
    const size = `${Math.round(box.width)}×${Math.round(box.height)}`;
    if (hit.length === 0) return `frame ${id} grew to ${size} to hold its contents.`;
    const ids = hit.map((h) => h.id);
    return (
      `frame ${id} grew to ${size} to hold its contents and now overlaps ${them(ids)}. ` +
      `Move ${ids.length === 1 ? 'it' : 'them'} ${clearance(box, hit.map(boxOfEl), FRAME_MOVE_GAP)} with update. A frame moves with everything in it.`
    );
  });
}

/** Arrows whose label covers the line, which happens when the shapes they join sit too close. */
function hiddenArrows(linear: Draft[]): string[] {
  const warnings: string[] = [];
  for (const arrow of linear) {
    if (arrow.type !== 'arrow') continue;
    const label = linear.find((d) => d.containerId === arrow.id);
    if (!label) continue;
    const [dx, dy] = arrow.points[arrow.points.length - 1];
    const length = Math.hypot(dx, dy);
    const needed = (Math.abs(dx) >= Math.abs(dy) ? label.width : label.height) + 2 * LABEL_CLEARANCE;
    if (length < needed) {
      warnings.push(
        `arrow ${arrow.id} is ${Math.round(length)} px long, so its label ${JSON.stringify(label.originalText ?? label.text)} hides it. ` +
          `Move the shapes it joins at least ${Math.ceil(needed - length)} px further apart.`,
      );
    }
  }
  return warnings;
}

// ── update ───────────────────────────────────────────────────────────────

const CONTAINERS = new Set(['rectangle', 'ellipse', 'diamond', 'arrow']);

/**
 * Measures and places `text` inside `container` the way Excalidraw lays out labels.
 * In a box, the label wraps LABEL_PADDING in from each side, and the box is at least
 * `minHeight` and tall enough to keep that room above and below.
 */
function layoutLabel(container: Draft, text: string, textEl: El | undefined, minHeight = container.height) {
  const t = textEl as Draft | undefined;
  const boxed = container.type === 'rectangle' && !container.points && container.width > 4 * LABEL_PADDING;
  const inset = boxed ? LABEL_PADDING - EXCALIDRAW_LABEL_PADDING : 0;
  const skel: ExSkeleton = {
    type: container.type,
    id: 'measure',
    x: container.x + inset,
    y: container.y,
    width: container.width - 2 * inset,
    height: container.height,
    ...(container.points ? { points: container.points } : {}),
    label: {
      text,
      strokeColor: t?.strokeColor ?? TEXT_COLOR,
      ...(t ? { fontSize: t.fontSize, fontFamily: t.fontFamily } : { fontFamily: TEXT_FONT }),
      ...(t?.textAlign ? { textAlign: t.textAlign } : {}),
    },
  };
  const [c, label] = convert([skel], true);
  const { x, y, width, height, fontSize, fontFamily, lineHeight } = label;
  const containerHeight = boxed ? Math.max(minHeight, height + 2 * LABEL_PADDING) : (c.height as number);
  return {
    containerHeight,
    text: {
      x,
      y: boxed ? container.y + (containerHeight - height) / 2 : y,
      width,
      height,
      fontSize,
      fontFamily,
      lineHeight,
      text: label.text,
      originalText: text,
    },
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
  const beforeGrowth = new Map<string, Box>();

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
        if (!container.points && laid.containerHeight > container.height) {
          beforeGrowth.set(u.id, { x: container.x, y: container.y, width: container.width, height: container.height });
          set(u.id, { height: laid.containerHeight });
        }
        if (textEl) {
          set(textEl.id, laid.text);
        } else {
          const id = randomId();
          const [fresh] = convert([{ type: 'text', id, x: laid.text.x, y: laid.text.y, text, fontFamily: TEXT_FONT }]);
          created.push({
            ...fresh,
            ...laid.text,
            containerId: u.id,
            frameId: container.frameId ?? null,
            textAlign: 'center',
            verticalAlign: 'middle',
            strokeColor: TEXT_COLOR,
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
  const warnings = grownShapes(beforeGrowth, next);
  return { next, response: { ids, batchId, ...(warnings.length ? { warnings } : {}) } };
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
