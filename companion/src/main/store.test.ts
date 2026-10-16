import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BoardStore, StateFile, cleanName, migrateData } from './store';

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

  it('reads a saved Items mode as Review', () => {
    const dir = temp();
    writeFileSync(join(dir, 'state.json'), '{"mode":"items"}');
    expect(new StateFile(dir).state.mode).toBe('review');
  });
});

describe('migrateData', () => {
  const oldWithBoards = () => {
    const root = temp();
    const oldDir = join(root, 'Web Agent Companion');
    mkdirSync(join(oldDir, 'boards'), { recursive: true });
    writeFileSync(join(oldDir, 'boards', 'scratch.excalidraw'), '{}');
    writeFileSync(join(oldDir, 'state.json'), '{"currentBoard":"scratch"}');
    mkdirSync(join(oldDir, 'Cache'));
    return { root, oldDir, newDir: join(root, 'Agent Brief') };
  };

  it('renames the whole folder when the new one does not exist yet', () => {
    const { oldDir, newDir } = oldWithBoards();
    expect(migrateData(oldDir, newDir)).toBe(true);
    expect(existsSync(join(newDir, 'boards', 'scratch.excalidraw'))).toBe(true);
    expect(existsSync(oldDir)).toBe(false);
  });

  it('moves only the app data into a new folder Chromium already made', () => {
    const { oldDir, newDir } = oldWithBoards();
    mkdirSync(join(newDir, 'Cache'), { recursive: true });
    expect(migrateData(oldDir, newDir)).toBe(true);
    expect(readFileSync(join(newDir, 'state.json'), 'utf8')).toContain('scratch');
    expect(existsSync(join(newDir, 'boards', 'scratch.excalidraw'))).toBe(true);
    expect(existsSync(join(oldDir, 'Cache'))).toBe(true);
  });

  it('does nothing once the new folder has boards, or without old boards', () => {
    const { oldDir, newDir } = oldWithBoards();
    mkdirSync(join(newDir, 'boards'), { recursive: true });
    expect(migrateData(oldDir, newDir)).toBe(false);
    expect(existsSync(join(oldDir, 'boards', 'scratch.excalidraw'))).toBe(true);
    expect(migrateData(join(temp(), 'none'), join(temp(), 'x'))).toBe(false);
  });
});
