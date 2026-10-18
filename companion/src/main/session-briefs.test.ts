import { describe, expect, it } from 'vitest';
import {
  boardHolder,
  BRIEF_TTL_MS,
  detachBoard,
  forgetBoard,
  heldBoards,
  liveFields,
  MAX_BRIEFS,
  moveBoard,
  prune,
  refreshLive,
  remember,
  renameBoard,
  sessionBoardName,
  sketchBoard,
  type SessionBriefs,
  unfiledBoardChoice,
} from './session-briefs';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 100 * DAY;
/** Midday local time, so the date reads Oct 16 in any time zone. */
const OCT_16 = new Date(2026, 9, 16, 12).getTime();

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
    expect(briefs.a).toEqual({ board: 'login', boards: ['login'], draftId: 'd1', at: NOW + 1 });
  });

  it('keeps item tracking across later opens, and can turn it off without moving the brief', () => {
    let briefs = remember({}, 'a', { board: 'login' }, NOW);
    briefs = remember(briefs, 'a', { trackItems: true }, NOW);
    briefs = remember(briefs, 'a', { draftId: 'd1', last: 'draft' }, NOW + 1);
    expect(briefs.a).toEqual({ board: 'login', boards: ['login'], draftId: 'd1', last: 'draft', trackItems: true, at: NOW + 1 });
    briefs = remember(briefs, 'a', { trackItems: false }, briefs.a!.at);
    expect(briefs.a).toEqual({ board: 'login', boards: ['login'], draftId: 'd1', last: 'draft', trackItems: false, at: NOW + 1 });
    expect(forgetBoard(briefs, 'login').a?.trackItems).toBe(false);
  });

  it('keeps every board a session opens, newest last, with the latest as its board', () => {
    let briefs = remember({}, 'a', { board: 'login', last: 'board' }, NOW);
    briefs = remember(briefs, 'a', { board: 'signup', last: 'board' }, NOW + 1);
    briefs = remember(briefs, 'a', { board: 'login', last: 'board' }, NOW + 2);
    expect(briefs.a).toEqual({ board: 'login', boards: ['login', 'signup'], last: 'board', at: NOW + 2 });
  });

  it('adds to a saved brief that has only a board', () => {
    const briefs = remember({ a: { board: 'login', at: NOW } }, 'a', { board: 'signup' }, NOW + 1);
    expect(briefs.a?.boards).toEqual(['login', 'signup']);
  });
});

describe('heldBoards', () => {
  it('reads a saved brief with only a board as holding that board', () => {
    expect(heldBoards({ board: 'login', at: NOW })).toEqual(['login']);
    expect(heldBoards({ at: NOW })).toEqual([]);
  });

  it('always includes the board it opened last', () => {
    expect(heldBoards({ board: 'b', boards: ['a', 'b'], at: NOW })).toEqual(['a', 'b']);
    expect(heldBoards({ board: 'c', boards: ['a'], at: NOW })).toEqual(['a', 'c']);
  });
});

describe('renameBoard', () => {
  it('renames the board in the list and as the opened board', () => {
    const briefs: SessionBriefs = {
      a: { board: 'old', boards: ['old', 'x'], at: 1 },
      b: { board: 'x', boards: ['old', 'x'], at: 2 },
      c: { board: 'old', at: 3 },
      d: { board: 'y', at: 4 },
    };
    expect(renameBoard(briefs, 'old', 'new')).toEqual({
      a: { board: 'new', boards: ['new', 'x'], at: 1 },
      b: { board: 'x', boards: ['new', 'x'], at: 2 },
      c: { board: 'new', boards: ['new'], at: 3 },
      d: { board: 'y', at: 4 },
    });
  });
});

describe('liveFields and refreshLive', () => {
  const host = { terminal: 'ghostty', bundleId: 'com.mitchellh.ghostty' };

  it('keeps the terminal a session ran in, and keeps it when a later open knows none', () => {
    const live = { sessionId: 'a', cwd: '/p/app', host };
    expect(liveFields(live)).toEqual({ title: 'app', cwd: '/p/app', host });
    let briefs = remember({}, 'a', { board: 'login', ...liveFields(live) }, NOW);
    briefs = remember(briefs, 'a', { draftId: 'd1', ...liveFields({ sessionId: 'a', cwd: '/p/app', title: 'Fix login' }) }, NOW + 1);
    expect(briefs.a).toEqual({ board: 'login', boards: ['login'], draftId: 'd1', title: 'Fix login', cwd: '/p/app', host, at: NOW + 1 });
  });

  it('updates a registered session brief in place, and leaves the rest alone', () => {
    const briefs: SessionBriefs = { a: { board: 'login', cwd: '/p/app', title: 'app', at: NOW - DAY }, b: { board: 'x', at: NOW } };
    const next = refreshLive(briefs, [{ sessionId: 'a', cwd: '/p/app', host }, { sessionId: 'c', cwd: '/p/c' }]);
    expect(next).toEqual({ a: { board: 'login', cwd: '/p/app', title: 'app', host, at: NOW - DAY }, b: { board: 'x', at: NOW } });
    expect(refreshLive(next, [{ sessionId: 'a', cwd: '/p/app', host: { ...host } }])).toBe(next);
  });
});

describe('forgetBoard', () => {
  it('drops a deleted board and reopens the draft instead', () => {
    const briefs = {
      a: { board: 'gone', draftId: 'd1', last: 'board' as const, at: 1 },
      b: { board: 'gone', last: 'board' as const, at: 2 },
      c: { board: 'kept', at: 3 },
    };
    expect(forgetBoard(briefs, 'gone')).toEqual({
      a: { draftId: 'd1', last: 'draft', at: 1 },
      b: { at: 2 },
      c: { board: 'kept', at: 3 },
    });
  });

  it('falls back to the newest remaining board when the opened one goes', () => {
    const briefs: SessionBriefs = { a: { board: 'gone', boards: ['one', 'two', 'gone'], last: 'board', at: 1 } };
    expect(forgetBoard(briefs, 'gone')).toEqual({ a: { board: 'two', boards: ['one', 'two'], last: 'board', at: 1 } });
  });

  it('drops an older board from the list and keeps the opened one', () => {
    const briefs: SessionBriefs = { a: { board: 'two', boards: ['gone', 'two'], last: 'board', at: 1 } };
    expect(forgetBoard(briefs, 'gone')).toEqual({ a: { board: 'two', boards: ['two'], last: 'board', at: 1 } });
  });

  it('reopens the draft when the last board in the list goes', () => {
    const briefs: SessionBriefs = { a: { board: 'gone', boards: ['gone'], draftId: 'd1', last: 'board', at: 1 } };
    expect(forgetBoard(briefs, 'gone')).toEqual({ a: { draftId: 'd1', last: 'draft', at: 1 } });
  });
});

describe('detachBoard', () => {
  const briefs: SessionBriefs = {
    a: { board: 'two', boards: ['one', 'two'], last: 'board', at: 1 },
    b: { board: 'one', at: 2 },
  };

  it('takes a board out of one session only', () => {
    expect(detachBoard(briefs, 'a', 'one')).toEqual({
      a: { board: 'two', boards: ['two'], last: 'board', at: 1 },
      b: { board: 'one', at: 2 },
    });
  });

  it('re-points the session at its newest remaining board', () => {
    expect(detachBoard(briefs, 'a', 'two').a).toEqual({ board: 'one', boards: ['one'], last: 'board', at: 1 });
  });

  it('detaches the board of a saved brief that has no list', () => {
    expect(detachBoard(briefs, 'b', 'one').b).toEqual({ at: 2 });
  });

  it('leaves the briefs alone for an unknown session or board', () => {
    expect(detachBoard(briefs, 'z', 'one')).toBe(briefs);
    expect(detachBoard(briefs, 'a', 'none').a).toBe(briefs.a);
  });
});

describe('moveBoard', () => {
  const briefs: SessionBriefs = {
    a: { board: 'two', boards: ['one', 'two'], last: 'board', at: 1 },
    b: { board: 'mine', boards: ['mine'], last: 'board', at: 2 },
    c: { draftId: 'n1', last: 'draft', at: 3 },
  };

  it('adds an unfiled board to the session and keeps its open board', () => {
    expect(moveBoard(briefs, 'loose', 'b').b).toEqual({ board: 'mine', boards: ['mine', 'loose'], last: 'board', at: 2 });
  });

  it('takes the board out of the session that held it', () => {
    const moved = moveBoard(briefs, 'two', 'b');
    expect(moved.a).toEqual({ board: 'one', boards: ['one'], last: 'board', at: 1 });
    expect(moved.b.boards).toEqual(['mine', 'two']);
  });

  it('makes the board the open one of a session that has none', () => {
    expect(moveBoard(briefs, 'loose', 'c').c).toEqual({ draftId: 'n1', last: 'draft', board: 'loose', boards: ['loose'], at: 3 });
  });

  it('leaves the briefs alone for an unknown session', () => {
    expect(moveBoard(briefs, 'one', 'z')).toBe(briefs);
  });
});

describe('sketchBoard', () => {
  const boards = new Set(['scratch', 'login']);
  const base = {
    sessionId: 'a',
    briefs: {} as SessionBriefs,
    current: 'scratch',
    now: OCT_16,
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

  it('the first time, makes a board named after the date when the current one has content', () => {
    expect(sketchBoard({ ...base, isEmpty: () => false })).toEqual({ board: 'Oct 16', isNew: true });
  });

  it('never takes an empty current board another session holds', () => {
    const briefs = { b: { board: 'scratch', at: NOW } };
    expect(sketchBoard({ ...base, briefs })).toEqual({ board: 'Oct 16', isNew: true });
  });

  it('never takes an empty current board that sits earlier in another session list', () => {
    const briefs: SessionBriefs = { b: { board: 'login', boards: ['scratch', 'login'], at: NOW } };
    expect(sketchBoard({ ...base, briefs })).toEqual({ board: 'Oct 16', isNew: true });
  });

  it('falls back when the remembered board was deleted or renamed', () => {
    const briefs = { a: { board: 'gone', at: NOW } };
    expect(sketchBoard({ ...base, briefs })).toEqual({ board: 'scratch', isNew: false });
    expect(sketchBoard({ ...base, briefs, isEmpty: () => false })).toEqual({ board: 'Oct 16', isNew: true });
  });
});

describe('unfiledBoardChoice', () => {
  const board = (name: string, updatedAt: number, sessionId?: string) => ({ name, updatedAt, elementCount: 0, ...(sessionId ? { sessionId } : {}) });

  it('reopens the board Unfiled last used when it still exists and no session holds it', () => {
    const boards = [board('kept', 1), board('newer', 9)];
    expect(unfiledBoardChoice({ remembered: 'kept', boards })).toEqual({ board: 'kept', isNew: false });
  });

  it('takes the most recently updated unfiled board when the remembered one is gone or held', () => {
    const boards = [board('old', 1), board('recent', 5), board('held', 9, 's1')];
    expect(unfiledBoardChoice({ remembered: 'gone', boards })).toEqual({ board: 'recent', isNew: false });
    expect(unfiledBoardChoice({ remembered: 'held', boards })).toEqual({ board: 'recent', isNew: false });
    expect(unfiledBoardChoice({ remembered: undefined, boards })).toEqual({ board: 'recent', isNew: false });
  });

  it('makes a new scratch board when every board is held', () => {
    expect(unfiledBoardChoice({ remembered: undefined, boards: [] })).toEqual({ board: 'scratch', isNew: true });
    const boards = [board('scratch', 1, 's1'), board('scratch 2', 2, 's2'), board('Oct 16', 3, 's1')];
    expect(unfiledBoardChoice({ remembered: 'scratch', boards })).toEqual({ board: 'scratch 3', isNew: true });
  });
});

describe('sessionBoardName', () => {
  const none = () => false;

  it('names a board after the date', () => {
    expect(sessionBoardName(OCT_16, none)).toBe('Oct 16');
    expect(sessionBoardName(new Date(2026, 0, 3, 12).getTime(), none)).toBe('Jan 3');
  });

  it('numbers it when the name is taken', () => {
    const taken = new Set(['Oct 16', 'Oct 16 2']);
    expect(sessionBoardName(OCT_16, (n) => taken.has(n))).toBe('Oct 16 3');
  });
});

describe('boardHolder', () => {
  it('finds a board earlier in a session list', () => {
    const briefs: SessionBriefs = { a: { board: 'two', boards: ['one', 'two'], at: NOW } };
    expect(boardHolder(briefs, 'one')).toBe('a');
    expect(boardHolder(briefs, 'two')).toBe('a');
  });

  it('gives a board in two lists to the most recently used brief', () => {
    const briefs: SessionBriefs = { old: { board: 'x', boards: ['login', 'x'], at: NOW - 1 }, recent: { board: 'y', boards: ['login', 'y'], at: NOW } };
    expect(boardHolder(briefs, 'login')).toBe('recent');
  });

  it('finds the session whose brief holds the board', () => {
    const briefs: SessionBriefs = { a: { board: 'login', at: NOW }, b: { board: 'Oct 16', at: NOW } };
    expect(boardHolder(briefs, 'login')).toBe('a');
    expect(boardHolder(briefs, 'scratch')).toBeUndefined();
  });

  it('counts an ended session, whose brief keeps the board', () => {
    const briefs: SessionBriefs = { ended: { title: 'Ended session', board: 'login', at: NOW - DAY } };
    expect(boardHolder(briefs, 'login')).toBe('ended');
  });

  it('picks the most recently used brief when two hold the board', () => {
    const briefs: SessionBriefs = { old: { board: 'login', at: NOW - DAY }, recent: { board: 'login', at: NOW }, mid: { board: 'login', at: NOW - 1 } };
    expect(boardHolder(briefs, 'login')).toBe('recent');
  });

  it('prefers a live holder over a more recently used ended one', () => {
    const briefs: SessionBriefs = { ended: { board: 'login', at: NOW }, live: { board: 'login', at: NOW - DAY }, alsoLive: { board: 'login', at: NOW - 2 * DAY } };
    const isLive = (id: string) => id !== 'ended';
    expect(boardHolder(briefs, 'login', isLive)).toBe('live');
  });
});
