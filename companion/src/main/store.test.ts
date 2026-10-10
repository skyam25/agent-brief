import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BoardStore, StateFile, cleanName } from './store';

const temp = () => mkdtempSync(join(tmpdir(), 'store-'));

describe('BoardStore', () => {
  it('creates, saves, lists and renames boards with their notes', () => {
    const store = new BoardStore(temp());
    expect(store.create('  plan ')).toBe('plan');
    store.saveScene('plan', JSON.stringify({ elements: [{ id: 'a' }, { id: 'b', isDeleted: true }] }));
    store.saveNotes('plan', 'remember');
    expect(store.list()).toMatchObject([{ name: 'plan', elementCount: 1 }]);
    expect(store.rename('plan', 'roadmap')).toBe('roadmap');
    expect(store.exists('plan')).toBe(false);
    expect(store.load('roadmap').notes).toBe('remember');
    expect(() => store.rename('missing', 'x')).toThrow(/no board/);
    store.create('other');
    let clash: unknown;
    try {
      store.rename('roadmap', 'other');
    } catch (err) {
      clash = err;
    }
    expect(clash).toMatchObject({ code: 'conflict', message: 'a board named "other" exists' });
    expect(store.load('roadmap').notes).toBe('remember');
  });

  it('keeps an existing board when created again', () => {
    const store = new BoardStore(temp());
    store.create('a');
    store.saveScene('a', '{"elements":[{"id":"x"}]}');
    store.create('a');
    expect(store.load('a').scene).toContain('"x"');
  });

  it('rejects unsafe and reserved names', () => {
    for (const bad of ['', '../x', 'a/b', '.hidden', 'current', 'x'.repeat(65)]) {
      expect(() => cleanName(bad)).toThrow();
    }
    expect(cleanName('Sprint 3 - ideas')).toBe('Sprint 3 - ideas');
  });
});

describe('StateFile', () => {
  it('persists updates over defaults', () => {
    const dir = temp();
    new StateFile(dir).update({ width: 900, currentBoard: 'b' });
    const again = new StateFile(dir);
    expect(again.state).toMatchObject({ width: 900, height: 760, currentBoard: 'b', hotkey: 'Control+Alt+S', deliveryMode: 'submit', openAtLogin: false });
    expect(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).width).toBe(900);
  });
});
