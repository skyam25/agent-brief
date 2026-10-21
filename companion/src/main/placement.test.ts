import { describe, expect, it } from 'vitest';
import { areaUnder, centredBounds, reachable } from './placement';

const left = { id: 1, bounds: { x: 0, y: 0, width: 1440, height: 900 }, workArea: { x: 0, y: 25, width: 1440, height: 875 } };
const right = { id: 2, bounds: { x: 1440, y: -200, width: 2560, height: 1440 }, workArea: { x: 1440, y: -200, width: 2560, height: 1400 } };

describe('panel placement', () => {
  it('picks the display under the cursor, else the nearest', () => {
    expect(areaUnder([left, right], { x: 100, y: 100 }).id).toBe(1);
    expect(areaUnder([left, right], { x: 2000, y: 1000 }).id).toBe(2);
    expect(areaUnder([left, right], { x: 5000, y: 0 }).id).toBe(2);
  });

  it('centres the panel in the work area of that display', () => {
    expect(centredBounds(right.workArea, { width: 1100, height: 760 })).toEqual({ x: 2170, y: 120, width: 1100, height: 760 });
  });

  it('shrinks a panel larger than the display', () => {
    expect(centredBounds(left.workArea, { width: 2000, height: 1200 })).toEqual({ x: 0, y: 25, width: 1440, height: 875 });
  });

  it('keeps a spot whose title bar can still be dragged', () => {
    const areas = [left.workArea, right.workArea];
    const panel = { width: 1100, height: 760 };
    expect(reachable(areas, { x: 200, y: 100, ...panel })).toBe(true);
    expect(reachable(areas, { x: 1200, y: 100, ...panel })).toBe(true);
    expect(reachable(areas, { x: -1060, y: 100, ...panel })).toBe(false);
    expect(reachable(areas, { x: 200, y: 890, ...panel })).toBe(false);
    expect(reachable([left.workArea], { x: 2000, y: 100, ...panel })).toBe(false);
  });
});
