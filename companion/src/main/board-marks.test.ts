import { describe, expect, it } from 'vitest';
import { DONE_GRACE_MS, forgetMarks, isDone, mark, renameMarks } from './board-marks';

describe('board marks', () => {
  it('pins in order and unpins', () => {
    const pinned = mark({ pinnedBoards: ['a'] }, ['b', 'a'], { pinned: true }, 0);
    expect(pinned.pinnedBoards).toEqual(['b', 'a']);
    expect(mark(pinned, ['b'], { pinned: false }, 0).pinnedBoards).toEqual(['a']);
  });

  it('leaves the other mark alone', () => {
    expect(mark({ pinnedBoards: ['a'] }, ['a'], { done: true }, 5)).toEqual({ doneBoards: { a: 5 } });
  });

  it('keeps a board done until an edit after the grace', () => {
    const marks = mark({}, ['a'], { done: true }, 1000);
    expect(isDone(marks, 'a', 900)).toBe(true);
    expect(isDone(marks, 'a', 1000 + DONE_GRACE_MS)).toBe(true);
    expect(isDone(marks, 'a', 1001 + DONE_GRACE_MS)).toBe(false);
    expect(isDone(mark(marks, ['a'], { done: false }, 2000), 'a', 900)).toBe(false);
  });

  it('follows renames and forgets deleted boards', () => {
    const marks = { pinnedBoards: ['a', 'b'], doneBoards: { a: 1 } };
    expect(renameMarks(marks, 'a', 'c')).toEqual({ pinnedBoards: ['c', 'b'], doneBoards: { c: 1 } });
    expect(forgetMarks(marks, ['a'])).toEqual({ pinnedBoards: ['b'], doneBoards: {} });
  });
});
