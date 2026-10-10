import { describe, expect, it } from 'vitest';
import { CLAUDE_COLOR, PALETTE, colorNameOf, isColorName, swatch } from './palette';

describe('palette', () => {
  it('has a distinct stroke and fill for every name', () => {
    const strokes = Object.values(PALETTE).map((s) => s.stroke);
    const fills = Object.values(PALETTE).map((s) => s.fill);
    expect(new Set(strokes).size).toBe(strokes.length);
    expect(new Set(fills).size).toBe(fills.length);
  });

  it('falls back to Claude violet for unknown or missing names', () => {
    expect(CLAUDE_COLOR).toBe('violet');
    expect(swatch(undefined)).toBe(PALETTE.violet);
    expect(swatch('mauve' as never)).toBe(PALETTE.violet);
    expect(swatch(undefined, 'yellow')).toBe(PALETTE.yellow);
    expect(swatch('green')).toBe(PALETTE.green);
  });

  it('maps hex back to names, preferring strokes', () => {
    expect(colorNameOf('#1971C2')).toBe('blue');
    expect(colorNameOf('#ffec99')).toBe('yellow');
    expect(colorNameOf('#123456')).toBeUndefined();
    expect(isColorName('red')).toBe(true);
    expect(isColorName('toString')).toBe(false);
  });
});
