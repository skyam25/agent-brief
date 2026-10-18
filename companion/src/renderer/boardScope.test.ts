import { describe, expect, it } from 'vitest';
import type { BoardEntry, Draft } from '../shared/ipc';
import { boardsOf, childrenOf, fallbackBoard, pickerRows } from './boardScope';

const board = (name: string, sessionId?: string): BoardEntry => ({ name, updatedAt: 0, elementCount: 0, ...(sessionId && { sessionId }) });
const draft = (id: string, body: string, extra: Partial<Draft> = {}): Draft => ({ id, body, status: 'note', rank: 0, createdAt: 0, updatedAt: 0, ...extra });

const boards = [board('Oct 16', 'a'), board('scratch'), board('Oct 15', 'b'), board('ideas')];

describe('boardsOf', () => {
  it('keeps a session its own boards and Unfiled the boards no session holds', () => {
    expect(boardsOf(boards, 'a').map((b) => b.name)).toEqual(['Oct 16']);
    expect(boardsOf(boards, undefined).map((b) => b.name)).toEqual(['scratch', 'ideas']);
  });
});

describe('childrenOf', () => {
  const drafts = [
    draft('n1', 'Login flow', { sessionId: 'a' }),
    draft('n2', '   ', { sessionId: 'a' }),
    draft('n3', 'Review body', { sessionId: 'a', review: { path: 'out.html', comments: [] } as unknown as Draft['review'] }),
    draft('n4', 'Loose idea'),
    draft('n5', 'Orphan', { sessionId: 'gone' }),
    draft('n6', 'Other session', { sessionId: 'b' }),
  ];

  it('lists a session its boards and counts its notes with text, leaving reviews out', () => {
    const kids = childrenOf(boards, drafts, 'a', ['a', 'b']);
    expect(kids.boards.map((b) => b.name)).toEqual(['Oct 16']);
    expect(kids.noteCount).toBe(1);
  });

  it('gives Unfiled the unfiled boards and counts the notes no tab holds', () => {
    const kids = childrenOf(boards, drafts, undefined, ['a', 'b']);
    expect(kids.boards.map((b) => b.name)).toEqual(['scratch', 'ideas']);
    expect(kids.noteCount).toBe(2);
  });
});

describe('pickerRows', () => {
  it('lists a live session its boards and offers the unfiled ones to attach', () => {
    expect(pickerRows(boards, 'Oct 16', 'a', true)).toEqual({ own: ['Oct 16'], attach: ['scratch', 'ideas'] });
  });

  it('keeps the current board in the list when the container lacks it', () => {
    expect(pickerRows(boards, 'scratch', 'a', true)).toEqual({ own: ['scratch', 'Oct 16'], attach: ['ideas'] });
  });

  it('offers nothing to attach on an ended session or on Unfiled', () => {
    expect(pickerRows(boards, 'Oct 16', 'a', false).attach).toEqual([]);
    expect(pickerRows(boards, 'scratch', undefined, true)).toEqual({ own: ['scratch', 'ideas'], attach: [] });
  });

  it('never lists a board another session holds', () => {
    const { own, attach } = pickerRows(boards, 'Oct 16', 'a', true);
    expect([...own, ...attach]).not.toContain('Oct 15');
  });
});

describe('fallbackBoard', () => {
  const held = [{ ...board('Oct 14', 'a'), updatedAt: 3 }, { ...board('Oct 16', 'a'), updatedAt: 9 }, { ...board('Oct 15', 'a'), updatedAt: 5 }, { ...board('loose'), updatedAt: 99 }];

  it("picks the session's newest board other than the one leaving", () => {
    expect(fallbackBoard(held, 'a', ['Oct 14'])).toBe('Oct 16');
    expect(fallbackBoard(held, 'a', ['Oct 16'])).toBe('Oct 15');
  });

  it('skips every board that is leaving', () => {
    expect(fallbackBoard(held, 'a', ['Oct 16', 'Oct 15'])).toBe('Oct 14');
  });

  it('picks the newest unfiled board for Unfiled', () => {
    expect(fallbackBoard([...held, { ...board('older'), updatedAt: 1 }], undefined, ['loose'])).toBe('older');
  });

  it('gives nothing when the session holds no other board', () => {
    expect(fallbackBoard([board('Oct 16', 'a'), board('loose')], 'a', ['Oct 16'])).toBeUndefined();
  });
});
