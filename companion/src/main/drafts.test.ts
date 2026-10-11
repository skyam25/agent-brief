import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Draft } from '../shared/ipc';
import { sortDrafts } from '../shared/drafts';
import { DraftStore } from './drafts';

const temp = () => mkdtempSync(join(tmpdir(), 'drafts-'));

const draft = (id: string, patch: Partial<Draft> = {}): Draft => ({
  id,
  body: `body ${id}`,
  status: 'note',
  rank: 0,
  createdAt: 1,
  updatedAt: 1,
  ...patch,
});

describe('DraftStore', () => {
  it('saves, lists, renames boards and removes drafts', () => {
    const store = new DraftStore(temp());
    store.save(draft('a', { board: 'flow' }));
    store.save(draft('b'));
    expect(store.list().map((d) => d.id).sort()).toEqual(['a', 'b']);
    expect(store.get('a')?.board).toBe('flow');

    store.renameBoard('flow', 'checkout');
    expect(store.get('a')?.board).toBe('checkout');

    store.remove('a');
    expect(store.get('a')).toBeUndefined();
    expect(readdirSync(store.dir)).toEqual(['b.json']);
  });

  it('refuses ids that are unsafe as file names and drops unknown fields', () => {
    const store = new DraftStore(temp());
    expect(() => store.save(draft('../x'))).toThrow(/draft id/);
    expect(() => store.save({ ...draft('a'), status: 'sent' })).toThrow(/status/);
    const saved = store.save({ ...draft('a'), extra: 1 } as Draft);
    expect(saved).not.toHaveProperty('extra');
  });

  it('skips a damaged file instead of failing the whole list', () => {
    const store = new DraftStore(temp());
    store.save(draft('a'));
    writeFileSync(join(store.dir, 'bad.json'), '{');
    expect(store.list().map((d) => d.id)).toEqual(['a']);
  });
});

describe('sortDrafts', () => {
  it('puts Ready drafts first by rank, then notes newest first', () => {
    const sorted = sortDrafts([
      draft('old-note', { updatedAt: 1 }),
      draft('second', { status: 'ready', rank: 2 }),
      draft('new-note', { updatedAt: 5 }),
      draft('first', { status: 'ready', rank: 1 }),
    ]);
    expect(sorted.map((d) => d.id)).toEqual(['first', 'second', 'new-note', 'old-note']);
  });
});
