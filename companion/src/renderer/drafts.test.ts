import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Draft } from '../shared/ipc';
import { DRAFT_SAVE_MS, DraftBook } from './drafts';

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
