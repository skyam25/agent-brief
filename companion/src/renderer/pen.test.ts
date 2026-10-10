import { describe, expect, it } from 'vitest';
import { ERASER_BUTTON, PEN_RANGE_MS, PenRange, TouchFilter, curvePressure, penButton } from './pen';

/** Excalidraw's freehand radius factor: easeOutSine(0.5 - thinning * (0.5 - p)) with thinning 0.6. */
const radius = (p: number) => Math.sin(((0.5 - 0.6 * (0.5 - p)) * Math.PI) / 2);

describe('pressure curve', () => {
  it('leaves 0.5, full pressure and zero alone', () => {
    // Exactly 0.5 must survive, because Excalidraw reads a flat 0.5 as a mouse-like pen and simulates pressure.
    expect(curvePressure(0.5)).toBe(0.5);
    expect(Object.is(curvePressure(0.5), 0.5)).toBe(true);
    expect(curvePressure(1)).toBe(1);
    expect(curvePressure(0)).toBe(0);
    expect(curvePressure(0.8)).toBe(0.8);
  });

  it('rises monotonically through the light half', () => {
    const xs = [0.05, 0.1, 0.2, 0.3, 0.4, 0.49, 0.5];
    const ys = xs.map(curvePressure);
    for (let i = 1; i < ys.length; i++) expect(ys[i]).toBeGreaterThan(ys[i - 1]);
  });

  it('gives 0.2 vs 1.0 at least a 2x width ratio, which raw pressure misses', () => {
    expect(radius(1) / radius(0.2)).toBeLessThan(2);
    expect(radius(curvePressure(1)) / radius(curvePressure(0.2))).toBeGreaterThan(2.2);
  });
});

describe('eraser button', () => {
  const ev = (over: Partial<{ type: string; pointerType: string; button: number; buttons: number }>) => ({
    type: 'pointerdown',
    pointerType: 'pen',
    button: 0,
    buttons: 1,
    ...over,
  });

  it('maps a pen press with the eraser bit to button 5', () => {
    expect(penButton(ev({ buttons: 32 }))).toBe(ERASER_BUTTON);
    expect(penButton(ev({ buttons: 33 }))).toBe(ERASER_BUTTON);
  });

  it('leaves everything else alone', () => {
    expect(penButton(ev({}))).toBe(0);
    expect(penButton(ev({ button: 5, buttons: 32 }))).toBe(5);
    expect(penButton(ev({ type: 'pointermove', button: -1, buttons: 32 }))).toBe(-1);
    expect(penButton(ev({ pointerType: 'mouse', buttons: 32 }))).toBe(0);
    expect(penButton(ev({ button: 2, buttons: 2 }))).toBe(2);
  });
});

describe('pen range and touch filter', () => {
  it('counts the pen in range while hovering, and for PEN_RANGE_MS after it leaves', () => {
    const r = new PenRange();
    expect(r.inRange(0)).toBe(false);
    r.seen('pointermove', 100);
    expect(r.inRange(100_000)).toBe(true);
    r.seen('pointerout', 200);
    expect(r.inRange(200 + PEN_RANGE_MS - 1)).toBe(true);
    expect(r.inRange(200 + PEN_RANGE_MS)).toBe(false);
  });

  it('blocks a touch that starts on the canvas while the pen is near, until it lifts', () => {
    const r = new PenRange();
    const f = new TouchFilter(r);
    r.seen('pointermove', 0);
    expect(f.block({ type: 'pointerdown', pointerId: 1 }, true, 10)).toBe(true);
    r.seen('pointerout', 20);
    expect(f.block({ type: 'pointermove', pointerId: 1 }, true, 5000)).toBe(true);
    expect(f.block({ type: 'pointerup', pointerId: 1 }, true, 5000)).toBe(true);
    expect(f.block({ type: 'pointermove', pointerId: 1 }, true, 5001)).toBe(false);
  });

  it('lets touch through off the canvas, with no pen near, and for touches begun before the pen came', () => {
    const r = new PenRange();
    const f = new TouchFilter(r);
    expect(f.block({ type: 'pointerdown', pointerId: 2 }, true, 0)).toBe(false);
    r.seen('pointerover', 10);
    expect(f.block({ type: 'pointermove', pointerId: 2 }, true, 20)).toBe(false);
    expect(f.block({ type: 'pointerdown', pointerId: 3 }, false, 30)).toBe(false);
  });
});
