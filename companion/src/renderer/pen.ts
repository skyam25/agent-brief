/**
 * Pen handling that runs before Excalidraw sees pointer events:
 * a pressure curve, eraser-button normalising, and touch rejection while a pen is in range.
 */

/** How long after the last pen event the pen still counts as in range. */
export const PEN_RANGE_MS = 1000;

/**
 * Excalidraw's freehand renderer narrows strokes only to about half width at
 * light pressure, so 0.2 vs 1.0 comes out under 2x. This curve deepens the
 * light half and leaves 0.5 alone, which keeps Excalidraw's mouse-like pen
 * detection (a flat 0.5 turns on simulated pressure).
 */
export const PRESSURE_GAMMA = 1.6;

export function curvePressure(p: number): number {
  if (!(p > 0) || p >= 0.5) return p;
  return 0.5 * (2 * p) ** PRESSURE_GAMMA;
}

/** Excalidraw's eraser button. */
export const ERASER_BUTTON = 5;
const ERASER_BUTTONS_BIT = 32;

interface PointerLike {
  type: string;
  pointerType: string;
  button: number;
  buttons: number;
}

/**
 * The button Excalidraw should see. Some drivers report the eraser end as
 * `buttons & 32` with `button 0`; Excalidraw only knows `button 5`.
 */
export function penButton(e: PointerLike): number {
  if (e.pointerType === 'pen' && e.type === 'pointerdown' && e.button === 0 && e.buttons & ERASER_BUTTONS_BIT) {
    return ERASER_BUTTON;
  }
  return e.button;
}

/** Tracks whether the pen hovers or touched within the last PEN_RANGE_MS. */
export class PenRange {
  private hovering = false;
  private lastPenAt = -Infinity;

  seen(type: string, t: number): void {
    this.lastPenAt = t;
    if (type === 'pointerover' || type === 'pointerdown' || type === 'pointermove') this.hovering = true;
    if (type === 'pointerout' || type === 'pointercancel') this.hovering = false;
  }

  inRange(t: number): boolean {
    return this.hovering || t - this.lastPenAt < PEN_RANGE_MS;
  }
}

/**
 * Decides which touch events to swallow. A touch that starts on the canvas
 * while the pen is in range is blocked until it lifts, even if the pen leaves.
 */
export class TouchFilter {
  private readonly blocked = new Set<number>();

  constructor(private readonly range: PenRange) {}

  block(e: { type: string; pointerId: number }, onCanvas: boolean, t: number): boolean {
    if (e.type === 'pointerdown' && onCanvas && this.range.inRange(t)) this.blocked.add(e.pointerId);
    if (!this.blocked.has(e.pointerId)) return false;
    if (e.type === 'pointerup' || e.type === 'pointercancel') this.blocked.delete(e.pointerId);
    return true;
  }
}

const POINTER_EVENTS = ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'pointerover', 'pointerout'] as const;

function override(e: Event, key: string, value: unknown): void {
  Object.defineProperty(e, key, { value, configurable: true });
}

export interface PenState {
  /** True while the pen hovers or touches, or did so in the last PEN_RANGE_MS. */
  inRange(): boolean;
  dispose(): void;
}

/** Installs the handlers on the window, filtering touch only inside `canvasRoot`. */
export function installPen(canvasRoot: () => HTMLElement | null, now: () => number = () => performance.now()): PenState {
  const range = new PenRange();
  const touch = new TouchFilter(range);

  const onPointer = (e: PointerEvent) => {
    if (e.pointerType === 'pen') {
      range.seen(e.type, now());
      if (e.type !== 'pointerover' && e.type !== 'pointerout') override(e, 'pressure', curvePressure(e.pressure));
      const button = penButton(e);
      if (button !== e.button) override(e, 'button', button);
      return;
    }
    if (e.pointerType !== 'touch') return;
    const root = canvasRoot();
    const onCanvas = !!root && e.target instanceof Node && root.contains(e.target);
    if (touch.block(e, onCanvas, now())) {
      e.stopImmediatePropagation();
      e.preventDefault();
    }
  };

  for (const type of POINTER_EVENTS) window.addEventListener(type, onPointer, { capture: true });
  return {
    inRange: () => range.inRange(now()),
    dispose: () => {
      for (const type of POINTER_EVENTS) window.removeEventListener(type, onPointer, { capture: true });
    },
  };
}
