import { describe, expect, it, vi } from 'vitest';
import { claimDecisions, decisionsClaim, subscribeDecisions } from './decisions-send';

describe('decisions send', () => {
  it('hands the footer Send to the newest Feedback view and tells subscribers', () => {
    const heard = vi.fn();
    const off = subscribeDecisions(heard);
    const side = { count: 1, send: () => undefined };
    const full = { count: 3, send: () => undefined };
    expect(decisionsClaim()).toBeUndefined();
    const releaseSide = claimDecisions(side);
    const releaseFull = claimDecisions(full);
    expect(decisionsClaim()).toBe(full);
    releaseFull();
    expect(decisionsClaim()).toBe(side);
    releaseSide();
    expect(decisionsClaim()).toBeUndefined();
    expect(heard).toHaveBeenCalledTimes(4);
    off();
  });
});
