import { describe, expect, it } from 'vitest';
import type { SessionBriefEntry } from '../shared/ipc';
import { groupBriefs, noteCountLabel, sessionState, sidebarOrder } from './SessionSidebar';

const brief = (sessionId: string, isLive: boolean): SessionBriefEntry => ({ sessionId, title: sessionId, at: 0, isLive, isTarget: false, hasContent: false });

describe('groupBriefs', () => {
  it('splits running from ended and keeps the order within each', () => {
    const { running, ended } = groupBriefs([brief('a', false), brief('b', true), brief('c', false), brief('d', true)]);
    expect(running.map((b) => b.sessionId)).toEqual(['b', 'd']);
    expect(ended.map((b) => b.sessionId)).toEqual(['a', 'c']);
  });

  it('orders the shortcuts as the sidebar lists them', () => {
    expect(sidebarOrder([brief('a', false), brief('b', true), brief('c', false), brief('d', true)])).toEqual(['b', 'd', 'a', 'c']);
  });
});

describe('noteCountLabel', () => {
  it('counts one note and many', () => {
    expect(noteCountLabel(1)).toBe('1 note');
    expect(noteCountLabel(3)).toBe('3 notes');
  });
});

describe('sessionState', () => {
  const now = 10 * 60_000;
  it('reads working, idle with its last reply, or ended', () => {
    expect(sessionState({ isLive: true, isWorking: true, at: 0 }, now).label).toBe('Working');
    expect(sessionState({ isLive: true, activeAt: now - 5 * 60_000, at: 0 }, now).label).toBe('Idle 5m');
    expect(sessionState({ isLive: true, at: 0 }, now).label).toBe('Idle');
    expect(sessionState({ isLive: false, at: now - 3 * 60_000 }, now)).toEqual({ label: '3m', tip: 'Ended: Claude Code closed. Resume it from here' });
  });
});
