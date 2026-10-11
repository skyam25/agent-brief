import { describe, expect, it } from 'vitest';
import type { SessionBriefEntry } from '../shared/ipc';
import { tabsThatFit, visibleTabs } from './BriefTabs';

const brief = (sessionId: string): SessionBriefEntry => ({ sessionId, title: sessionId, at: 1, isLive: true, isTarget: false, hasContent: false });
const five = ['a', 'b', 'c', 'd', 'e'].map(brief);

describe('tabsThatFit', () => {
  it('shows every tab when they fit, else leaves room for the overflow button', () => {
    expect(tabsThatFit(3, 1000)).toBe(3);
    expect(tabsThatFit(5, 600)).toBe(3);
    expect(tabsThatFit(5, 100)).toBe(1);
  });
});

describe('visibleTabs', () => {
  it('keeps the newest that fit', () => {
    expect(visibleTabs(five, 3, 'b').map((b) => b.sessionId)).toEqual(['a', 'b', 'c']);
  });

  it('swaps in the active tab when it would hide', () => {
    expect(visibleTabs(five, 3, 'e').map((b) => b.sessionId)).toEqual(['a', 'b', 'e']);
    expect(visibleTabs(five, 1, 'e').map((b) => b.sessionId)).toEqual(['e']);
  });
});
