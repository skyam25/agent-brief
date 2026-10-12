import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Draft } from '../shared/ipc';
import { DRAFT_SAVE_MS, DraftBook, onTab } from './drafts';

function fakeHost(initial: Draft[] = []) {
  const disk = new Map(initial.map((d) => [d.id, d]));
  return {
    disk,
    listDrafts: vi.fn(async () => [...disk.values()]),
    saveDraft: vi.fn(async (d: Draft) => void disk.set(d.id, d)),
    deleteDraft: vi.fn(async (id: string) => void disk.delete(id)),
  };
}

const saved = (id: string, patch: Partial<Draft> = {}): Draft => ({
  id,
  body: id,
  status: 'note',
  rank: 0,
  createdAt: 1,
  updatedAt: 1,
  ...patch,
});

let t = 100;
beforeEach(() => {
  vi.useFakeTimers();
  t = 100;
});
afterEach(() => vi.useRealTimers());

describe('DraftBook', () => {
  it('keeps a new note off disk until it has words, and drops it when left empty', async () => {
    const host = fakeHost();
    const book = new DraftBook(host, () => t++);
    const note = book.create();
    expect(book.create().id).toBe(note.id);
    await vi.advanceTimersByTimeAsync(DRAFT_SAVE_MS);
    expect(host.disk.size).toBe(0);

    book.edit(note.id, 'Fix the login redirect');
    await vi.advanceTimersByTimeAsync(DRAFT_SAVE_MS);
    expect(host.disk.get(note.id)?.body).toBe('Fix the login redirect');

    const other = book.create();
    book.select(note.id);
    expect(book.get(other.id)).toBeUndefined();
  });

  it('takes the id main asks for, in place of the open empty note', () => {
    const book = new DraftBook(fakeHost(), () => t++);
    const empty = book.create();
    const note = book.create('', 'from-main');
    expect(note.id).toBe('from-main');
    expect(book.selectedId).toBe('from-main');
    expect(book.get(empty.id)).toBeUndefined();
    expect(book.create('', 'from-main').id).toBe('from-main');
  });

  it('files a new note under a session, and moves it between sessions', async () => {
    const host = fakeHost();
    const book = new DraftBook(host, () => t++);
    const unfiled = book.create();
    const filed = book.create('', undefined, 's1');
    expect(filed.id).not.toBe(unfiled.id);
    expect(filed.sessionId).toBe('s1');

    book.edit(filed.id, 'For s1');
    await vi.advanceTimersByTimeAsync(DRAFT_SAVE_MS);
    expect(host.disk.get(filed.id)?.sessionId).toBe('s1');

    book.file(filed.id, 's2');
    await vi.advanceTimersByTimeAsync(DRAFT_SAVE_MS);
    expect(host.disk.get(filed.id)?.sessionId).toBe('s2');

    book.file(filed.id, undefined);
    await vi.advanceTimersByTimeAsync(DRAFT_SAVE_MS);
    expect(host.disk.get(filed.id)).not.toHaveProperty('sessionId');
  });

  it('keeps the output file a note was copied from, through edits and saves', async () => {
    const host = fakeHost();
    const book = new DraftBook(host, () => t++);
    book.create();
    const copy = book.create('# Pricing', 'out-1', 's1', { path: 'docs/pricing.md' });
    expect(copy.id).toBe('out-1');
    expect(book.selected?.source).toEqual({ path: 'docs/pricing.md' });
    book.edit(copy.id, '# Pricing, revised');
    await vi.advanceTimersByTimeAsync(DRAFT_SAVE_MS);
    expect(host.disk.get('out-1')).toMatchObject({ sessionId: 's1', source: { path: 'docs/pricing.md' } });
  });

  it('keeps its own filing over disk while that filing is unsaved', async () => {
    const host = fakeHost([saved('mine')]);
    const book = new DraftBook(host, () => t++);
    await book.load();
    book.file('mine', 's2');
    host.disk.set('mine', { ...host.disk.get('mine')!, sessionId: 's1' });

    await book.load();
    expect(book.get('mine')?.sessionId).toBe('s2');
    await vi.advanceTimersByTimeAsync(DRAFT_SAVE_MS);
    expect(host.disk.get('mine')?.sessionId).toBe('s2');
  });

  it('deletes a saved note that was emptied and then left', async () => {
    const host = fakeHost([saved('a')]);
    const book = new DraftBook(host, () => t++);
    await book.load();
    book.select('a');
    book.edit('a', '  ');
    book.select(undefined);
    await vi.runAllTimersAsync();
    expect(host.disk.has('a')).toBe(false);
  });

  it('queues Ready drafts at the end and reorders them', async () => {
    const host = fakeHost([saved('a'), saved('b'), saved('c')]);
    const book = new DraftBook(host, () => t++);
    await book.load();
    for (const id of ['a', 'b', 'c']) book.setReady(id, true);
    expect(book.ready.map((d) => d.id)).toEqual(['a', 'b', 'c']);

    book.move('c', 0);
    expect(book.ready.map((d) => d.id)).toEqual(['c', 'a', 'b']);
    await book.flush();
    expect([...host.disk.values()].sort((x, y) => x.rank - y.rank).map((d) => d.id)).toEqual(['c', 'a', 'b']);

    book.setReady('a', false);
    expect(book.ready.map((d) => d.id)).toEqual(['c', 'b']);
  });

  it('links one draft per board', async () => {
    const host = fakeHost([saved('a'), saved('b')]);
    const book = new DraftBook(host, () => t++);
    await book.load();
    book.link('a', 'flow');
    book.link('b', 'flow');
    expect(book.linkedTo('flow')?.id).toBe('b');
    expect(book.get('a')?.board).toBeUndefined();
    book.renameBoard('flow', 'checkout');
    expect(book.linkedTo('checkout')?.id).toBe('b');
  });

  it('lets go of a draft main used up, without deleting it again', async () => {
    const host = fakeHost([saved('a')]);
    const book = new DraftBook(host, () => t++);
    await book.load();
    book.select('a');
    book.consume('a', { body: 'a' });
    expect(book.selected).toBeUndefined();
    expect(host.deleteDraft).not.toHaveBeenCalled();
  });

  it('keeps and saves again text typed while the Send was on its way', async () => {
    const host = fakeHost([saved('a')]);
    const book = new DraftBook(host, () => t++);
    await book.load();
    book.edit('a', 'a and more');
    host.disk.delete('a');
    book.consume('a', { body: 'a' });
    await book.flush();
    expect(host.disk.get('a')?.body).toBe('a and more');
  });

  it('keeps edits not saved yet when it reloads from disk', async () => {
    const host = fakeHost([saved('a')]);
    const book = new DraftBook(host, () => t++);
    await book.load();
    book.edit('a', 'newer');
    const fresh = book.create('brand new');
    await book.load();
    expect(book.get('a')?.body).toBe('newer');
    expect(book.get(fresh.id)?.body).toBe('brand new');
    await book.flush();
    expect(host.disk.get('a')?.body).toBe('newer');
  });

  it('retries a failed save and reports why until it succeeds', async () => {
    const host = fakeHost();
    host.saveDraft.mockRejectedValueOnce(new Error('disk full')).mockRejectedValueOnce(new Error('disk full'));
    const book = new DraftBook(host, () => t++);
    const note = book.create('keep me');
    await book.flush();
    expect(book.saveError).toBe('disk full');
    expect(host.disk.has(note.id)).toBe(false);
    await book.flush();
    expect(host.disk.get(note.id)?.body).toBe('keep me');
    expect(book.saveError).toBeUndefined();
  });
});

describe('DraftBook during a Send or a save', () => {
  it('keeps a board attached while the Send was on its way', async () => {
    const host = fakeHost([saved('a')]);
    const book = new DraftBook(host, () => t++);
    await book.load();
    book.link('a', 'flow');
    book.consume('a', { body: 'a' });
    expect(book.get('a')?.board).toBe('flow');
  });

  it('keeps an edit whose save is still on its way when a reload lands', async () => {
    const host = fakeHost([saved('a')]);
    let release!: () => void;
    host.saveDraft.mockImplementationOnce(
      (d: Draft) => new Promise<undefined>((r) => (release = () => r(void host.disk.set(d.id, d)))),
    );
    const book = new DraftBook(host, () => t++);
    await book.load();
    book.edit('a', 'newer');
    const stale = [...host.disk.values()];
    host.listDrafts.mockResolvedValueOnce(stale);
    await vi.advanceTimersByTimeAsync(DRAFT_SAVE_MS);
    await book.load();
    expect(book.get('a')?.body).toBe('newer');
    release();
  });

  it('flush tries a failed save once more before giving up', async () => {
    const host = fakeHost();
    host.saveDraft.mockRejectedValueOnce(new Error('busy'));
    const book = new DraftBook(host, () => t++);
    const note = book.create('keep me');
    await book.flush();
    expect(host.disk.get(note.id)?.body).toBe('keep me');
  });
});

describe('DraftBook pictures', () => {
  const png = 'data:image/png;base64,AAAA';
  const gif = 'data:image/gif;base64,BBBB';

  it('keeps a pasted picture while the body references it, and saves it with the draft', async () => {
    const host = fakeHost([saved('a')]);
    const book = new DraftBook(host, () => t++);
    await book.load();
    book.attach('a', 'shot01', png);
    book.edit('a', 'Look at this\n\n![login form](att:shot01)');
    await book.flush();
    expect(host.disk.get('a')?.attachments).toEqual({ shot01: png });
  });

  it('drops a picture once the body no longer references it, and removes the field when none remain', async () => {
    const host = fakeHost([saved('a', { body: '![](att:shot01) ![](att:shot02)', attachments: { shot01: png, shot02: gif } })]);
    const book = new DraftBook(host, () => t++);
    await book.load();
    book.edit('a', '![](att:shot02)');
    expect(book.get('a')?.attachments).toEqual({ shot02: gif });
    book.edit('a', 'words only');
    expect(book.get('a')).not.toHaveProperty('attachments');
    await book.flush();
    expect(host.disk.get('a')).not.toHaveProperty('attachments');
  });

  it('brings a dropped picture back when an undo restores its reference', async () => {
    const book = new DraftBook(fakeHost([saved('a')]), () => t++);
    await book.load();
    book.attach('a', 'shot01', png);
    book.edit('a', '![](att:shot01)');
    book.edit('a', '');
    book.edit('a', '![](att:shot01)');
    expect(book.get('a')?.attachments).toEqual({ shot01: png });
  });

  it('finds a picture pasted from another draft', async () => {
    const book = new DraftBook(fakeHost([saved('a', { body: '![](att:shot01)', attachments: { shot01: png } }), saved('b')]), () => t++);
    await book.load();
    book.edit('b', 'Same as before ![](att:shot01)');
    expect(book.get('b')?.attachments).toEqual({ shot01: png });
  });

  it('counts a draft holding only a picture as not empty', async () => {
    const host = fakeHost();
    const book = new DraftBook(host, () => t++);
    const note = book.create();
    book.attach(note.id, 'shot01', png);
    book.edit(note.id, '![](att:shot01)');
    book.create();
    expect(book.get(note.id)?.attachments).toEqual({ shot01: png });
    await book.flush();
    expect(host.disk.has(note.id)).toBe(true);
  });
});

describe('onTab', () => {
  it('puts a filed note on its session tab, and unfiled or orphaned notes on Notes', async () => {
    const tabs = ['s1'];
    const unfiled = saved('u');
    const filed = saved('f', { sessionId: 's1' });
    const orphan = saved('o', { sessionId: 'gone' });
    expect([unfiled, filed, orphan].map((d) => onTab(d, 's1', tabs))).toEqual([false, true, false]);
    expect([unfiled, filed, orphan].map((d) => onTab(d, undefined, tabs))).toEqual([true, false, true]);

    const book = new DraftBook(fakeHost([saved('e', { body: ' ', sessionId: 's1' }), filed, orphan]), () => t++);
    await book.load();
    expect(book.firstOnTab('s1', tabs)?.id).toBe('f');
    expect(book.firstOnTab(undefined, tabs)?.id).toBe('o');
    expect(book.firstOnTab('s2', tabs)).toBeUndefined();
  });
});
