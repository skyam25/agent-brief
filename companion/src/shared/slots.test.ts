import { describe, expect, it } from 'vitest';
import { findSlots, nextSlot, slashQuery } from './slots';

const text = 'Fix {{what}}.\nSteps: {{ steps }}\nNot a slot: {{}} or {{\n}}';

describe('slots', () => {
  it('finds named slots on one line', () => {
    expect(findSlots(text).map((s) => [s.name, text.slice(s.start, s.end)])).toEqual([
      ['what', '{{what}}'],
      ['steps', '{{ steps }}'],
    ]);
  });

  it('steps forward and back, wrapping around', () => {
    const [a, b] = findSlots(text);
    expect(nextSlot(text, 0)).toEqual(a);
    expect(nextSlot(text, a.end)).toEqual(b);
    expect(nextSlot(text, b.end)).toEqual(a);
    expect(nextSlot(text, b.start, true)).toEqual(a);
    expect(nextSlot(text, a.start, true)).toEqual(b);
    expect(nextSlot('no slots', 0)).toBeUndefined();
  });
});

describe('slashQuery', () => {
  it('reads a slash at the start of the current line', () => {
    expect(slashQuery('hello\n/bug re', 13)).toEqual({ start: 6, query: 'bug re' });
    expect(slashQuery('/', 1)).toEqual({ start: 0, query: '' });
    expect(slashQuery('a /bug', 6)).toBeUndefined();
  });
});
