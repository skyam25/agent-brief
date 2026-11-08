/**
 * Fits a newly opened board again while its view settles. The native view can change size after the
 * board opens, such as when the navigation push ends or the panel docks, and Excalidraw keeps the old fit.
 * Stops at the first touch, so it never moves a view the person has used.
 */
export function refitWhileSettling(view: HTMLElement, fit: () => void, ms = 3000): () => void {
  let size = `${view.clientWidth}x${view.clientHeight}`;
  const observer = new ResizeObserver(() => {
    const next = `${view.clientWidth}x${view.clientHeight}`;
    if (next === size) return;
    size = next;

    // Excalidraw reads its new size on the same resize, so the fit waits a frame.
    requestAnimationFrame(fit);
  });
  const stop = () => {
    observer.disconnect();
    clearTimeout(timer);
    view.removeEventListener('pointerdown', stop, true);
  };
  const timer = setTimeout(stop, ms);
  observer.observe(view);
  view.addEventListener('pointerdown', stop, true);
  return stop;
}
