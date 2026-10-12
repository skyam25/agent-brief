/** Applies the Stack layout to an Excalidraw scene, and turns dropped or pasted files into image elements. */

import { convertToExcalidrawElements, newElementWith } from '@excalidraw/excalidraw';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { AppState } from '@excalidraw/excalidraw/types';
import { planStack, type Arrival, type StackElement, type StackPlan } from '../board/stack';
import type { PlannedFile } from '../board/skeleton';
import { shrink } from './images';
import { randomId } from './ops';

type El = ExcalidrawElement;

/** The image types Excalidraw shows. */
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export const imageFiles = (files: FileList | null | undefined): File[] => Array.from(files ?? []).filter((f) => IMAGE_TYPES.has(f.type));

/** True while the user drags, resizes or draws, when moving things would fight the pointer. */
export const isBusy = (s: AppState): boolean => s.selectedElementsAreBeingDragged || s.isResizing || s.isRotating || s.newElement !== null;

export function plan(elements: readonly El[], arrival?: Arrival): StackPlan {
  return planStack(elements as unknown as StackElement[], { arrival, newId: randomId });
}

/** The elements after the plan. New frames go last, as `draw` adds them. */
export function applyPlan(elements: readonly El[], p: StackPlan): El[] {
  const next = elements.map((e) => {
    const patch = p.patches.get(e.id);
    return patch ? newElementWith(e, patch as never) : e;
  });
  if (p.frames.length === 0) return next;
  const frames = convertToExcalidrawElements(
    p.frames.map((f) => ({ type: 'frame', id: f.id, name: f.name, children: [] })) as never,
  ) as unknown as Record<string, unknown>[];
  // Conversion refits frames to their children, so put back the planned boxes.
  frames.forEach((fr, i) => {
    const { x, y, width, height, customData } = p.frames[i];
    Object.assign(fr, { x, y, width, height, customData, index: null });
  });
  return [...next, ...(frames as unknown as El[])];
}

function readAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error('could not read the file'));
    reader.readAsDataURL(file);
  });
}

function naturalSize(src: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error('could not decode the image'));
    img.src = src;
  });
}

/** Image elements for dropped or pasted files, at their natural size. The layout places them. */
export async function imagesFor(files: File[], now = Date.now()): Promise<{ elements: El[]; files: PlannedFile[] }> {
  const out: { elements: El[]; files: PlannedFile[] } = { elements: [], files: [] };
  for (const file of files) {
    const dataURL = await shrink(await readAsDataURL(file));
    const { width, height } = await naturalSize(dataURL);
    const id = randomId();
    const fileId = `file-${id}`;
    const mimeType = /^data:(image\/[a-z]+);/.exec(dataURL)?.[1] ?? file.type;
    out.files.push({ id: fileId, dataURL, mimeType } as PlannedFile);
    const [el] = convertToExcalidrawElements([
      { type: 'image', id, x: 0, y: 0, width, height, fileId, status: 'saved', scale: [1, 1] },
    ] as never) as unknown as Record<string, unknown>[];
    Object.assign(el, { customData: { createdAt: now }, index: null });
    out.elements.push(el as unknown as El);
  }
  return out;
}
