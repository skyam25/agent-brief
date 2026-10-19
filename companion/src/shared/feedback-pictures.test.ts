import { describe, expect, it } from 'vitest';
import { defaultPictureRound, picturesByRound, snapLine, snapName } from './feedback-pictures';

describe('snap names', () => {
  it('names the picture by item, round and side, beside the output', () => {
    expect(snapName(6, 1, 'before')).toBe('6-r1-before.png');
    expect(snapName(6, 1, 'after', 3)).toBe('6-r1-after-3.png');
    expect(snapLine('prototype/checkout.html', 6, 2, 'after')).toBe('checkout.html.feedback/6-r2-after.png');
    expect(snapLine('checkout.html', 6, 1, 'before')).toBe('checkout.html.feedback/6-r1-before.png');
  });
});

describe('picturesByRound', () => {
  const lines = (...texts: [string, string][]) => texts.map(([key, text]) => ({ key, text }));

  it("pairs each round's first Before with its latest After", () => {
    const item = { round: 1, rounds: [1, 2], lines: lines(['Before', 'c.html.feedback/6-r1-before.png'], ['After', 'c.html.feedback/6-r1-after.png'], ['Before', 'c.html.feedback/6-r2-before.png'], ['Before', 'c.html.feedback/6-r1-before-2.png'], ['After', 'c.html.feedback/6-r1-after-2.png · clipped to the top 10000px']) };
    const rounds = picturesByRound(item);
    expect(rounds).toEqual([
      { round: 1, before: 'c.html.feedback/6-r1-before.png', after: 'c.html.feedback/6-r1-after-2.png' },
      { round: 2, before: 'c.html.feedback/6-r2-before.png' },
    ]);
    expect(defaultPictureRound(rounds)).toBe(1);
  });

  it('puts a hand-named picture in the first round, and opens on the latest round with any', () => {
    const rounds = picturesByRound({ round: 3, rounds: [3], lines: lines(['After', 'shots/new.png']) });
    expect(rounds).toEqual([{ round: 3, after: 'shots/new.png' }]);
    expect(defaultPictureRound(rounds)).toBe(3);
    expect(defaultPictureRound([])).toBeUndefined();
  });
});
