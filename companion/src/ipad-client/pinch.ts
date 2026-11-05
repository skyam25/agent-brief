/** Keeps pinch working once an Apple Pencil has turned on Excalidraw's pen mode. */

import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';

/**
 * Pen mode fixes the pinch scale at 1 while the draw tool is on, so fingers could never zoom.
 * The hand tool stands in for as long as two fingers are down, and the draw tool comes back when they lift.
 */
export function keepPinch(root: HTMLElement, api: ExcalidrawImperativeAPI): () => void {
  const fingers = new Set<number>();
  let pens = 0;
  let standingIn = false;

  const onDown = (e: PointerEvent) => {
    if (e.pointerType === 'pen') pens++;
    if (e.pointerType !== 'touch') return;
    fingers.add(e.pointerId);
    const { activeTool, penMode } = api.getAppState();
    if (fingers.size === 2 && !pens && !standingIn && penMode && activeTool.type === 'freedraw') {
      standingIn = true;
      api.setActiveTool({ type: 'hand' });
    }
  };
  const onUp = (e: PointerEvent) => {
    if (e.pointerType === 'pen') pens = Math.max(0, pens - 1);
    fingers.delete(e.pointerId);
    if (standingIn && fingers.size === 0) {
      standingIn = false;
      api.setActiveTool({ type: 'freedraw' });
    }
  };
  root.addEventListener('pointerdown', onDown, { capture: true });
  window.addEventListener('pointerup', onUp, { capture: true });
  window.addEventListener('pointercancel', onUp, { capture: true });
  return () => {
    root.removeEventListener('pointerdown', onDown, { capture: true });
    window.removeEventListener('pointerup', onUp, { capture: true });
    window.removeEventListener('pointercancel', onUp, { capture: true });
  };
}
