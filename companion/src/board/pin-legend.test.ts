import { describe, expect, it } from 'vitest';
import { legendLayout, pinSize, wrapWords } from './pin-legend';

/** Every character is 10 px wide. */
const measure = (s: string) => s.length * 10;

describe('pin size', () => {
  it('is at least 28 px and grows with the picture', () => {
    expect(pinSize(400, 300)).toBe(28);
    expect(pinSize(2400, 1600)).toBeGreaterThanOrEqual(36);
    expect(pinSize(1600, 2400)).toBe(pinSize(2400, 1600));
  });
});

describe('wrapping', () => {
  it('breaks at spaces to fit the width', () => {
    expect(wrapWords('Chips: All · Home · Office', 120, measure)).toEqual(['Chips: All ·', 'Home ·', 'Office']);
    expect(wrapWords('short', 120, measure)).toEqual(['short']);
  });

  it('cuts a word longer than the line', () => {
    expect(wrapWords('abcdefghijklmnop', 60, measure)).toEqual(['abcdef', 'ghijkl', 'mnop']);
  });

  it('keeps at most the line cap and marks the cut', () => {
    expect(wrapWords('one two three four five six', 100, measure, 2)).toEqual(['one two', 'three fou…']);
  });

  it('treats line breaks as spaces', () => {
    expect(wrapWords('a\n\nb', 100, measure)).toEqual(['a b']);
  });
});

describe('legend layout', () => {
  it('stacks one row per pin under the picture, each as tall as its lines or its badge', () => {
    const layout = legendLayout(['Chips: All · Home · Office', 'bigger'], 2400, 1600, measure)!;
    const u = pinSize(2400, 1600);
    expect(layout.unit).toBe(u);
    expect(layout.rows).toHaveLength(2);
    expect(layout.rows[0]!.lines).toEqual(['Chips: All · Home · Office']);
    expect(layout.rows[1]!.top).toBeGreaterThan(layout.rows[0]!.top);
    const last = layout.rows.at(-1)!;
    expect(layout.height).toBeGreaterThanOrEqual(last.top + Math.max(u, last.lines.length * layout.lineHeight));
    expect(layout.textX + measure('Chips: All · Home · Office')).toBeLessThanOrEqual(2400);
  });

  it('is empty when no pin has words', () => {
    expect(legendLayout([], 800, 600, measure)).toBeUndefined();
    expect(legendLayout(['  '], 800, 600, measure)).toBeUndefined();
  });
});
