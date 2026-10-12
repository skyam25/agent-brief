/** Keeps the board's view clear of Excalidraw's floating toolbar. */

import { CaptureUpdateAction, getVisibleSceneBounds } from '@excalidraw/excalidraw';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { ExcalidrawImperativeAPI, NormalizedZoomValue } from '@excalidraw/excalidraw/types';

/** Room above a frame for its name, which Excalidraw draws outside it. */
const FRAME_NAME_ROOM = 24;

/** How far Excalidraw's floating toolbar reaches down over the canvas, in screen pixels. */
function toolbarInset(): number {
  const root = document.querySelector('.excalidraw');
  const bar = root?.querySelector('.App-toolbar');
  if (!root || !bar) return 0;
  return Math.max(0, bar.getBoundingClientRect().bottom - root.getBoundingClientRect().top);
}

/**
 * Fits what a freshly shown board holds without zooming past 100%. An empty
 * board starts unzoomed, with the origin below the toolbar.
 */
export function fitBoard(api: ExcalidrawImperativeAPI, live: readonly ExcalidrawElement[]): void {
  if (live.length) api.scrollToContent(live, { fitToViewport: true, viewportZoomFactor: 0.8, maxZoom: 1, animate: false });
  else {
    const scrollY = Math.round(toolbarInset() + FRAME_NAME_ROOM);
    api.updateScene({ appState: { scrollX: 0, scrollY, zoom: { value: 1 as NormalizedZoomValue } }, captureUpdate: CaptureUpdateAction.NEVER });
  }
}

/**
 * Fits new elements in view unless all of them show clear of the toolbar,
 * so the user sees what Claude drew.
 */
export function revealIfHidden(api: ExcalidrawImperativeAPI, ids: string[]): void {
  const wanted = new Set(ids);
  const drawn = api.getSceneElements().filter((e) => wanted.has(e.id));
  if (drawn.length === 0) return;
  const appState = api.getAppState();
  const [minX, minY, maxX, maxY] = getVisibleSceneBounds(appState);
  const top = minY + toolbarInset() / appState.zoom.value;
  const inView = drawn.every((e) => {
    const y = e.type === 'frame' ? e.y - FRAME_NAME_ROOM : e.y;
    return e.x >= minX && e.x + e.width <= maxX && y >= top && e.y + e.height <= maxY;
  });
  if (!inView) api.scrollToContent(drawn, { fitToViewport: true, viewportZoomFactor: 0.8, maxZoom: 1, animate: true });
}
