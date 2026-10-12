/** Watches the scene and keeps stroke events for the timeline, in epoch ms. */

import { diffScene, type ExcalidrawLikeElement } from '../voice/scene-diff';
import type { StrokeEvent } from '../voice/types';

/** Changes to one element closer together than this extend one event. */
const MERGE_MS = 1000;

type Snapshot = ExcalidrawLikeElement[];

/** Excalidraw elements, typed loosely so its own element types fit. */
type Elements = readonly object[];

/** Copies the fields diffScene reads. Excalidraw mutates elements in place, so references are not enough. */
export function snapshot(input: Elements): Snapshot {
  const elements = input as readonly ExcalidrawLikeElement[];
  return elements.map((e) => ({
    id: e.id,
    type: e.type,
    x: e.x,
    y: e.y,
    width: e.width,
    height: e.height,
    isDeleted: e.isDeleted,
    customData: e.customData,
    frameId: e.frameId,
    containerId: e.containerId,
    text: e.text,
    name: e.name,
    boundElements: e.boundElements,
  }));
}

export class StrokeLog {
  readonly events: StrokeEvent[] = [];
  private prev: Snapshot;

  constructor(initial: Elements = []) {
    this.prev = snapshot(initial);
  }

  /** Starts over from `elements`, as after a board switch or a Send. */
  reset(elements: Elements): void {
    this.events.length = 0;
    this.prev = snapshot(elements);
  }

  /**
   * Records what changed since the last call. A stroke being drawn or dragged
   * keeps extending its latest event instead of adding one per frame. `keep`
   * drops events, while the snapshot still moves on.
   */
  observe(elements: Elements, t: number, keep: (ev: StrokeEvent) => boolean = () => true): void {
    const next = snapshot(elements);
    const found = diffScene(this.prev, next, t).filter(keep);
    const byId = new Map(next.map((e) => [e.id, e]));
    this.prev = next;

    for (const ev of found) {
      const last = this.lastFor(ev.elementId);
      if (last && ev.kind === 'move' && last.kind !== 'erase' && t - last.tEnd < MERGE_MS) {
        last.tEnd = t;
        last.bbox = ev.bbox;
        continue;
      }
      this.events.push(ev);
    }

    // A stroke still growing has no new event, so stretch its add to now.
    for (const ev of this.events.slice(-8)) {
      if (ev.kind !== 'add' || t - ev.tEnd >= MERGE_MS) continue;
      const el = byId.get(ev.elementId);
      if (!el || el.isDeleted) continue;
      if (el.width !== ev.bbox.width || el.height !== ev.bbox.height || el.x !== ev.bbox.x || el.y !== ev.bbox.y) {
        ev.tEnd = t;
        ev.bbox = { x: el.x, y: el.y, width: el.width, height: el.height };
      }
    }
  }

  /**
   * Takes in changes the app made itself, such as the Stack layout moving
   * pictures. Nothing new is logged, but each moved element's latest event
   * takes its new box, so the timeline places marks on it correctly.
   */
  absorb(elements: Elements): void {
    const next = snapshot(elements);
    const before = new Map(this.prev.map((e) => [e.id, e]));
    for (const el of next) {
      const was = before.get(el.id);
      if (!was || el.isDeleted || (was.x === el.x && was.y === el.y && was.width === el.width && was.height === el.height)) continue;
      const last = this.lastFor(el.id);
      if (last && last.kind !== 'erase') last.bbox = { x: el.x, y: el.y, width: el.width, height: el.height };
    }
    this.prev = next;
  }

  private lastFor(id: string): StrokeEvent | undefined {
    for (let i = this.events.length - 1; i >= 0; i--) if (this.events[i].elementId === id) return this.events[i];
    return undefined;
  }
}

/** Moves events and segment starts so the session starts at 0. */
export function rebase<S extends { startedAt: number }>(
  events: StrokeEvent[],
  segments: S[],
): { strokes: StrokeEvent[]; segments: (S & { startMs: number })[]; origin: number } {
  const starts = [...events.map((e) => e.t), ...segments.map((s) => s.startedAt)];
  const origin = starts.length ? Math.min(...starts) : 0;
  return {
    origin,
    strokes: events.map((e) => ({ ...e, t: e.t - origin, tEnd: e.tEnd - origin, bbox: { ...e.bbox } })),
    segments: segments.map((s) => ({ ...s, startMs: s.startedAt - origin })),
  };
}
