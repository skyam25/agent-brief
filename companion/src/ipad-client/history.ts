/**
 * Undo and redo for the native toolbar. Excalidraw keeps its history private, so this presses its own
 * undo and redo buttons, which ipad.css hides, and reports when each one turns on or off.
 */

export interface HistoryState {
  undo: boolean;
  redo: boolean;
}

const button = (root: HTMLElement, which: 'undo' | 'redo') => root.querySelector<HTMLButtonElement>(`[data-testid="button-${which}"]`);

/** Presses Excalidraw's undo or redo button. */
export function press(root: HTMLElement, which: 'undo' | 'redo'): void {
  const target = button(root, which);
  if (target && !target.disabled) target.click();
}

/** Reads whether undo and redo can run now. */
export function historyState(root: HTMLElement): HistoryState {
  return { undo: button(root, 'undo')?.disabled === false, redo: button(root, 'redo')?.disabled === false };
}

/** Calls `report` with the state now and after each change. Returns a stop function. */
export function watchHistory(root: HTMLElement, report: (state: HistoryState) => void): () => void {
  let last = '';
  let frame = 0;
  const check = () => {
    frame = 0;
    const state = historyState(root);
    const key = `${state.undo}${state.redo}`;
    if (key === last) return;
    last = key;
    report(state);
  };

  // Excalidraw re-renders the buttons, so this watches the subtree and reads once a frame.
  const observer = new MutationObserver(() => {
    if (!frame) frame = requestAnimationFrame(check);
  });
  observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['disabled'] });
  check();
  return () => {
    observer.disconnect();
    if (frame) cancelAnimationFrame(frame);
  };
}
