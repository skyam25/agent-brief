import { describe, expect, it } from 'vitest';
import { badgeCentre, boxOf, edgePoint, fitScale, intersects, parseRegion, route, strokeStart, union } from './geometry';

describe('region math', () => {
  it('parses x,y,w,h and rejects anything else', () => {
    expect(parseRegion('10, 20,300,400')).toEqual({ x: 10, y: 20, width: 300, height: 400 });
    expect(parseRegion('1,2,3')).toBeUndefined();
    expect(parseRegion('a,b,c,d')).toBeUndefined();
    expect(parseRegion('0,0,0,10')).toBeUndefined();
    expect(parseRegion(undefined)).toBeUndefined();
  });

  it('treats touching boxes as intersecting', () => {
    const a = { x: 0, y: 0, width: 10, height: 10 };
    expect(intersects(a, { x: 10, y: 10, width: 5, height: 5 })).toBe(true);
    expect(intersects(a, { x: 11, y: 0, width: 5, height: 5 })).toBe(false);
    expect(intersects(a, { x: -5, y: 3, width: 1, height: 1 })).toBe(false);
  });

  it('unions boxes and gives an empty box for nothing', () => {
    expect(union([])).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    expect(union([
      { x: 0, y: 0, width: 10, height: 10 },
      { x: -5, y: 20, width: 10, height: 5 },
    ])).toEqual({ x: -5, y: 0, width: 15, height: 25 });
  });

  it('boxes linear elements by their points', () => {
    expect(boxOf({ type: 'arrow', x: 100, y: 100, width: 0, height: 0, points: [[0, 0], [-40, 30], [20, 50]] }))
      .toEqual({ x: 60, y: 100, width: 60, height: 50 });
  });

  it('fits the long edge under maxEdge and caps upscaling', () => {
    expect(fitScale(2800, 1000, 1400)).toBe(0.5);
    expect(fitScale(1000, 3500, 1400)).toBeCloseTo(0.4);
    expect(fitScale(300, 200, 1400)).toBe(2);
    expect(fitScale(0, 0, 1400)).toBe(1);
  });
});

describe('edge points and routes', () => {
  const rect = { type: 'rectangle', x: 0, y: 0, width: 200, height: 100 };

  it('leaves a rectangle through the facing side', () => {
    expect(edgePoint(rect, [500, 50])).toEqual([200, 50]);
    expect(edgePoint(rect, [100, -300])).toEqual([100, 0]);
  });

  it('leaves an ellipse and a diamond on their curves', () => {
    const ellipse = { ...rect, type: 'ellipse' };
    const [x, y] = edgePoint(ellipse, [300, 150]);
    expect(((x - 100) / 100) ** 2 + ((y - 50) / 50) ** 2).toBeCloseTo(1);
    const diamond = { ...rect, type: 'diamond' };
    const [dx, dy] = edgePoint(diamond, [300, 150]);
    expect(Math.abs(dx - 100) / 100 + Math.abs(dy - 50) / 50).toBeCloseTo(1);
  });

  it('routes shape to shape with a gap at both ends', () => {
    const right = { ...rect, x: 400 };
    const { from, to } = route({ shape: rect }, { shape: right }, 8);
    expect(from).toEqual([208, 50]);
    expect(to).toEqual([392, 50]);
  });

  it('keeps free points as given', () => {
    const { from, to } = route({ point: [5, 5] }, { shape: rect }, 8);
    expect(from).toEqual([5, 5]);
    expect(Math.hypot(to[0] - 5, to[1] - 5)).toBeLessThan(Math.hypot(100 - 5, 50 - 5));
  });
});

describe('stroke badges', () => {
  it('finds where a stroke starts and which way it runs', () => {
    const stroke = { type: 'freedraw', x: 100, y: 100, width: 0, height: 0, points: [[0, 0], [2, 0], [30, 0], [60, 5]] as [number, number][] };
    expect(strokeStart(stroke)).toEqual({ start: [100, 100], along: [130, 100] });
    expect(strokeStart({ type: 'rectangle', x: 10, y: 20, width: 100, height: 50 })).toEqual({ start: [10, 20], along: [60, 45] });
  });

  it('puts the badge behind the start point, clear of the ink', () => {
    expect(badgeCentre([100, 100], [130, 100], 8, 4)).toEqual([88, 100]);
    const [x, y] = badgeCentre([0, 0], [10, 10], 5, 5);
    expect(x).toBeCloseTo(-Math.SQRT1_2 * 10);
    expect(y).toBeCloseTo(-Math.SQRT1_2 * 10);
    expect(badgeCentre([5, 5], [5, 5], 1, 1)).toEqual([5 - Math.SQRT2, 5 - Math.SQRT2]);
  });
});
