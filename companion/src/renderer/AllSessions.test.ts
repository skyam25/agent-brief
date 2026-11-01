import { describe, expect, it } from 'vitest';
import type { BoardEntry, SessionBriefEntry } from '../shared/ipc';
import { findSessions, sessionGroups } from './AllSessions';

const board = (name: string, sessionId?: string): BoardEntry => ({ name, updatedAt: 0, elementCount: 0, ...(sessionId ? { sessionId } : {}) });
const brief = (sessionId: string, title: string, isLive: boolean): SessionBriefEntry => ({ sessionId, title, cwd: '/p/app', at: 0, isLive, isTarget: false, hasContent: false });

describe('All sessions', () => {
  const briefs = [brief('e', 'Login bug', false), brief('r', 'Research plan', true)];
  const boards = [board('scratch'), board('login-flow', 'e'), board('research-loop', 'r'), board('notes', 'r')];
  const groups = sessionGroups(briefs, boards);

  it('lists Unfiled, then running, then ended, each with its boards', () => {
    expect(groups.map((g) => [g.title, g.boards.map((b) => b.name)])).toEqual([
      ['Unfiled', ['scratch']],
      ['Research plan', ['research-loop', 'notes']],
      ['Login bug', ['login-flow']],
    ]);
  });

  it('keeps every board of a session whose title matches', () => {
    expect(findSessions(groups, 'research').map((g) => [g.title, g.boards.map((b) => b.name)])).toEqual([['Research plan', ['research-loop', 'notes']]]);
  });

  it('shows only the matching boards of a session found by a board', () => {
    expect(findSessions(groups, 'FLOW').map((g) => [g.title, g.boards.map((b) => b.name)])).toEqual([['Login bug', ['login-flow']]]);
  });

  it('matches the folder', () => {
    expect(findSessions(groups, 'app')).toHaveLength(2);
  });
});
