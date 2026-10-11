import { describe, expect, it } from 'vitest';
import { RateLimiter } from './limits';

describe('RateLimiter', () => {
  it('allows a burst, then refills at the rate', () => {
    const clock = { t: 0 };
    const limit = new RateLimiter({ burst: 3, perSecond: 2 }, () => clock.t);
    expect([1, 2, 3, 4].map(() => limit.take('a'))).toEqual([true, true, true, false]);
    clock.t += 499;
    expect(limit.take('a')).toBe(false);
    clock.t += 1;
    expect(limit.take('a')).toBe(true);
    clock.t += 60_000;
    expect([1, 2, 3, 4].map(() => limit.take('a'))).toEqual([true, true, true, false]);
  });

  it('keeps keys apart', () => {
    const limit = new RateLimiter({ burst: 1, perSecond: 0 }, () => 0);
    expect(limit.take('a')).toBe(true);
    expect(limit.take('a')).toBe(false);
    expect(limit.take('b')).toBe(true);
  });
});
