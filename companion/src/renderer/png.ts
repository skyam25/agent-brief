/**
 * PNG export of an Excalidraw scene, whole or cropped to a region,
 * with optional stroke number badges.
 */

import { convertToExcalidrawElements, exportToCanvas } from '@excalidraw/excalidraw';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { BinaryFiles } from '@excalidraw/excalidraw/types';
import type { Region } from '../server/contract';
import { badgeCentre, boxOf, fitScale, intersects, pad, strokeStart, union, type Point, type Shaped } from '../board/geometry';
import type { ExSkeleton } from '../board/skeleton';
import { randomId } from './ops';

type El = ExcalidrawElement;

const EXPORT_PADDING = 24;

/**
 * PNG of the live elements, or of `region` only, with the long edge at most
 * `maxEdge`. Exports for Claude are always light with a white background,
 * whatever theme the panel shows. `numbers` writes small stroke numbers and
 * image letters next to those elements, matching the labels in timeline.md.
 * `pins` draws comment pins at scene points, numbered from 1, matching comments.md.
 */
export async function renderPng(
  elements: readonly El[],
  files: BinaryFiles,
  opts: { region?: Region; maxEdge: number; numbers?: Record<string, number | string>; pins?: readonly Point[] },
): Promise<Uint8Array> {
  const els = elements.filter((e) => !e.isDeleted);
  const appState = { exportBackground: true, viewBackgroundColor: '#ffffff', exportWithDarkMode: false };
  const numbered = opts.numbers && Object.keys(opts.numbers).length > 0 ? opts.numbers : undefined;
  const pins = opts.pins?.length ? opts.pins : undefined;
  // Badges need a known origin, so a badged whole-board export crops to the padded box of the scene and its pins.
  const boxes = [...els.map((e) => boxOf(e as unknown as Shaped)), ...(pins ?? []).map(([x, y]) => ({ x, y, width: 0, height: 0 }))];
  const region =
    opts.region ??
    ((numbered || pins) && boxes.length > 0 ? pad(union(boxes), BADGE_ROOM, BADGE_ROOM + FRAME_NAME_ROOM) : undefined);
  let canvas: HTMLCanvasElement;
  if (region) {
    canvas = await renderRegion(els, files, region, opts.maxEdge);
    const scale = fitScale(region.width, region.height, opts.maxEdge);
    if (numbered) drawNumbers(canvas, els, numbered, region, scale);
    if (pins) drawPins(canvas, pins, region, scale);
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

/** Pin size in output pixels. */
const PIN_PX = 22;

/** The panel's accent, so pins on the PNG look like pins on the board. */
const PIN_COLOR = '#6965db';

/**
 * Draws each comment pin as the board shows it: a violet badge with its number,
 * whose square corner sits on the pinned spot. Sizes are in output pixels.
 */
function drawPins(canvas: HTMLCanvasElement, pins: readonly Point[], region: Region, scale: number): void {
  const ctx = canvas.getContext('2d')!;
  ctx.font = `700 ${BADGE_FONT_PX}px -apple-system, Helvetica, sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  pins.forEach(([x, y], i) => {
    const left = (x - region.x) * scale;
    const top = (y - region.y) * scale - PIN_PX;
    ctx.beginPath();
    ctx.roundRect(left, top, PIN_PX, PIN_PX, [PIN_PX / 2, PIN_PX / 2, PIN_PX / 2, 2]);
    ctx.fillStyle = PIN_COLOR;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.fillText(String(i + 1), left + PIN_PX / 2, top + PIN_PX / 2 + 0.5);
  });
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
  const [anchor, farAnchor] = convertToExcalidrawElements([
    anchorAt(all.x - ANCHOR_MARGIN, all.y - ANCHOR_MARGIN),
    anchorAt(all.x + all.width + ANCHOR_MARGIN, all.y + all.height + ANCHOR_MARGIN),
  ] as never, { regenerateIds: false });
  const full = await exportToCanvas({
    elements: [anchor, ...touching, farAnchor],
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
