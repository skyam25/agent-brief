import { describe, expect, it } from 'vitest';
import type { SessionBriefEntry } from '../shared/ipc';
import { folderTail, groupBriefs, noteCountLabel, sidebarOrder } from './SessionSidebar';

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

describe('folderTail', () => {
  it('keeps short paths and cuts long ones to their last two folders', () => {
    expect(folderTail('~/Projects/agent-brief')).toBe('~/Projects/agent-brief');
    expect(folderTail('/var/folders/hv/4q245sdd3/T/project-alpha')).toBe('…/T/project-alpha');
  });
});

describe('noteCountLabel', () => {
  it('counts one note and many', () => {
    expect(noteCountLabel(1)).toBe('1 note');
    expect(noteCountLabel(3)).toBe('3 notes');
  });
});
