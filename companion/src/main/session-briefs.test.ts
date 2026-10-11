import { describe, expect, it } from 'vitest';
import { BRIEF_TTL_MS, MAX_BRIEFS, prune, remember, sessionBoardName, sketchBoard, type SessionBriefs } from './session-briefs';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 100 * DAY;

describe('prune and remember', () => {
  it('drops records past 30 days and keeps the newest 100', () => {
    const briefs: SessionBriefs = { old: { board: 'a', at: NOW - BRIEF_TTL_MS - 1 }, fresh: { board: 'b', at: NOW - DAY } };
    expect(Object.keys(prune(briefs, NOW))).toEqual(['fresh']);

    const many: SessionBriefs = {};
    for (let i = 0; i < MAX_BRIEFS + 5; i++) many[`s${i}`] = { board: `b${i}`, at: NOW - i };
    const kept = prune(many, NOW);
    expect(Object.keys(kept)).toHaveLength(MAX_BRIEFS);
    expect(kept.s0).toBeDefined();
    expect(kept[`s${MAX_BRIEFS + 4}`]).toBeUndefined();
  });

  it('keeps the board when it records a draft, and the other way round', () => {
    let briefs = remember({}, 'a', { board: 'login' }, NOW);
    briefs = remember(briefs, 'a', { draftId: 'd1' }, NOW + 1);
    expect(briefs.a).toEqual({ board: 'login', draftId: 'd1', at: NOW + 1 });
  });
});

describe('sketchBoard', () => {
  const boards = new Set(['scratch', 'login']);
  const base = {
    sessionId: 'a',
    briefs: {} as SessionBriefs,
    current: 'scratch',
    label: 'agent-brief',
    exists: (n: string) => boards.has(n),
    isEmpty: () => true,
  };

  it('reopens the board the session last used', () => {
    const briefs = { a: { board: 'login', at: NOW } };
    expect(sketchBoard({ ...base, briefs })).toEqual({ board: 'login', isNew: false });
  });

  it('the first time, takes the current board when it is empty', () => {
    expect(sketchBoard(base)).toEqual({ board: 'scratch', isNew: false });
  });

  it('the first time, makes a board named after the session when the current one has content', () => {
    expect(sketchBoard({ ...base, isEmpty: () => false })).toEqual({ board: 'agent-brief', isNew: true });
  });

  it('never takes an empty current board another session holds', () => {
    const briefs = { b: { board: 'scratch', at: NOW } };
    expect(sketchBoard({ ...base, briefs })).toEqual({ board: 'agent-brief', isNew: true });
  });

  it('falls back when the remembered board was deleted or renamed', () => {
    const briefs = { a: { board: 'gone', at: NOW } };
    expect(sketchBoard({ ...base, briefs })).toEqual({ board: 'scratch', isNew: false });
    expect(sketchBoard({ ...base, briefs, isEmpty: () => false })).toEqual({ board: 'agent-brief', isNew: true });
  });
});

describe('sessionBoardName', () => {
  const none = () => false;

  it('makes a title safe as a board name', () => {
    expect(sessionBoardName('Fix: login / signup!', none)).toBe('Fix login signup');
    expect(sessionBoardName('  ✨ café ', none)).toBe('caf');
    expect(sessionBoardName('***', none)).toBe('session');
    expect(sessionBoardName('current', none)).toBe('current session');
    expect(sessionBoardName('x'.repeat(80), none)).toHaveLength(58);
  });

  it('numbers it when the name is taken', () => {
    const taken = new Set(['webapp', 'webapp 2']);
    expect(sessionBoardName('webapp', (n) => taken.has(n))).toBe('webapp 3');
  });
});
