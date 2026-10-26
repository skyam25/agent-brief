import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../server/testkit';
import { OutlineStore } from './outline';

const today = new Date(2026, 9, 25);

function setup() {
  const root = tempDir();
  mkdirSync(join(root, 'docs'));
  const changes: [string, string][] = [];
  const store = new OutlineStore((r, p) => void changes.push([r, p]), () => today);
  return { root, store, changes };
}

describe('outline store', () => {
  it('creates an outline beside its target and reads it back across stores', () => {
    const { root, store, changes } = setup();
    expect(store.create(root, { title: 'Onboarding memo', target: 'docs/memo.md' })).toBe('docs/memo.outline.md');
    expect(readFileSync(join(root, 'docs/memo.outline.md'), 'utf8')).toBe('# Onboarding memo\n\nTarget: docs/memo.md\nKind: document\n');
    expect(changes).toEqual([[root, 'docs/memo.outline.md']]);
    const doc = new OutlineStore().read(root, 'docs/memo.outline.md');
    expect(doc).toMatchObject({ title: 'Onboarding memo', target: 'docs/memo.md', path: 'docs/memo.outline.md', targetExists: false });
    expect(doc.version).toMatch(/^[0-9a-f]{64}$/);
    writeFileSync(join(root, 'docs/memo.md'), '# Memo');
    expect(store.read(root, 'docs/memo.outline.md').targetExists).toBe(true);
  });

  it('derives the path from the given path, then the target, then the title', () => {
    const { root, store } = setup();
    expect(store.create(root, { title: 'Plan', path: 'docs/plan.outline.md', target: 'docs/x.md' })).toBe('docs/plan.outline.md');
    expect(store.create(root, { title: 'Checkout', target: 'site/checkout.html', kind: 'page' })).toBe('site/checkout.outline.md');
    expect(store.read(root, 'site/checkout.outline.md')).toMatchObject({ kind: 'page', target: 'site/checkout.html' });
    expect(store.create(root, { title: 'Onboarding memo' })).toBe('onboarding-memo.outline.md');
    expect(() => store.create(root, { title: 'Onboarding memo' })).toThrow('already exists');
    expect(() => store.create(root, { title: '  ' })).toThrow('needs a title');
  });

  it('answers an empty outline with version missing, and no targetExists, when there is no file', () => {
    const { root, store } = setup();
    const doc = store.read(root, 'docs/none.outline.md');
    expect(doc).toEqual({ title: '', kind: 'document', intent: [], sections: [], sources: [], path: 'docs/none.outline.md', version: 'missing' });
  });

  it('applies ops, reports added ids, and rejects stale writes, hand edits included', () => {
    const { root, store } = setup();
    const path = store.create(root, { title: 'Memo' });
    const first = store.read(root, path);
    const next = store.update(root, path, { version: first.version, ops: [{ op: 'addSection', title: 'Why', label: 'w' }, { op: 'addPoint', section: '@w', text: 'Kickoffs wait six days.' }] });
    expect(next.added).toEqual(['s1', 'p1']);
    expect(next.sections[0]).toMatchObject({ id: 's1', title: 'Why', points: [{ id: 'p1', text: 'Kickoffs wait six days.' }] });
    expect(() => store.update(root, path, { version: first.version, ops: [{ op: 'removeSection', id: 's1' }] })).toThrow('changed since');
    writeFileSync(join(root, path), readFileSync(join(root, path), 'utf8') + 'stray line\n');
    expect(() => store.update(root, path, { version: next.version, ops: [{ op: 'removeSection', id: 's1' }] })).toThrow('changed since');
  });

  it('leaves the file alone on a bad op and names it', () => {
    const { root, store, changes } = setup();
    const path = store.create(root, { title: 'Memo' });
    const before = readFileSync(join(root, path), 'utf8');
    const { version } = store.read(root, path);
    expect(() => store.update(root, path, { version, ops: [{ op: 'addSection', title: 'A' }, { op: 'removePoint', id: 'p9' }] })).toThrow(/ops\[1\] removePoint/);
    expect(() => store.update(root, path, { ops: [] })).toThrow('Expected version and ops');
    expect(readFileSync(join(root, path), 'utf8')).toBe(before);
    expect(changes).toHaveLength(1);
  });

  it('needs a title for a new file', () => {
    const { root, store } = setup();
    expect(() => store.update(root, 'docs/x.outline.md', { version: 'missing', ops: [{ op: 'addSection', title: 'A' }] })).toThrow('setMeta');
  });

  it('makes missing folders inside the project', () => {
    const { root, store } = setup();
    expect(store.create(root, { title: 'Deep', path: 'a/b/deep.outline.md' })).toBe('a/b/deep.outline.md');
    expect(readFileSync(join(root, 'a/b/deep.outline.md'), 'utf8')).toContain('# Deep');
  });

  it('keeps paths inside the project, outside dot folders, and ending in .outline.md', () => {
    const { root, store } = setup();
    const outside = tempDir();
    symlinkSync(outside, join(root, 'out'));
    for (const path of ['../x.outline.md', '/tmp/x.outline.md', '.feedback/x.outline.md', 'docs/memo.md', '.outline.md', 'out/x.outline.md', 42]) {
      expect(() => store.read(root, path), String(path)).toThrow();
    }
    writeFileSync(join(outside, 'real.outline.md'), '# Real\n');
    symlinkSync(join(outside, 'real.outline.md'), join(root, 'docs/link.outline.md'));
    expect(() => store.read(root, 'docs/link.outline.md')).toThrow('regular file');
  });

  it('lists every outline in the project with counts, skipping dot folders', () => {
    const { root, store } = setup();
    const path = store.create(root, { title: 'Memo', target: 'docs/memo.md' });
    store.update(root, path, { version: store.read(root, path).version, ops: [
      { op: 'addSource', title: 'Dashboard' },
      { op: 'addSection', title: 'Why', label: 'w' },
      { op: 'addPoint', section: '@w', text: 'Waits are long.', cites: [{ source: 'S1' }] },
      { op: 'addPoint', section: '@w', text: 'Can support absorb it?', kind: 'open' },
    ] });
    mkdirSync(join(root, '.hidden'));
    writeFileSync(join(root, '.hidden/x.outline.md'), '# Hidden\n');
    expect(store.project(root)).toEqual({ files: [{ path, title: 'Memo', target: 'docs/memo.md', kind: 'document', sections: 1, points: 2, open: 1, cites: 1, unchecked: 1, flagged: 0 }] });
  });

  describe('change marks', () => {
    /** A store that tracks changes, with an outline Claude drafted: one section, two points and a source. */
    function drafted() {
      const root = tempDir();
      const changed: string[] = [];
      let at = new Date('2026-10-26T15:50:00Z');
      const store = new OutlineStore((_r, p) => void changed.push(p), () => at, join(tempDir(), 'changes'));
      const path = store.create(root, { title: 'Memo' });
      const write = (by: 'you' | 'claude', ops: unknown[]) => store.update(root, path, { version: store.read(root, path).version, ops }, by);
      write('claude', [
        { op: 'addSource', title: 'Dashboard' },
        { op: 'addSection', title: 'Why', label: 'w' },
        { op: 'addPoint', section: '@w', text: 'Waits are long.' },
        { op: 'addPoint', section: '@w', text: 'Support is busy.' },
      ]);
      const later = (iso: string) => (at = new Date(iso));
      return { root, path, store, write, changed, later };
    }

    it('marks nothing on a first draft, since all of it is new', () => {
      const { root, path, store } = drafted();
      expect(store.changes(root, path)).toBeUndefined();
    });

    it("lists Claude's added, edited and removed rows with their old wording", () => {
      const { root, path, store, write, later } = drafted();
      later('2026-10-26T16:05:00Z');
      write('claude', [
        { op: 'editPoint', id: 'p1', text: 'Waits run six days.', guide: 'Lead with it' },
        { op: 'removePoint', id: 'p2' },
        { op: 'addPoint', section: 's1', text: 'Churn follows the wait.' },
        { op: 'editSection', id: 's1', title: 'Why now' },
        { op: 'editSource', id: 'S1', supports: 'Wait times' },
      ]);
      expect(store.changes(root, path)).toEqual({
        at: '2026-10-26T16:05:00.000Z',
        rows: [
          { id: 's1', row: 'section', change: 'edited', was: ['Why'] },
          { id: 'p1', row: 'point', change: 'edited', was: ['Waits are long.', 'Guide · none'] },
          { id: 'p2', row: 'point', change: 'added', was: [] },
          { id: 'S1', row: 'source', change: 'edited', was: ['Supports · none'] },
          { id: 'p2', row: 'point', change: 'removed', was: ['Support is busy.'], section: 's1', after: 'p1' },
        ],
      });
    });

    it('drops a row you edit, and counts it again when Claude changes it after you', () => {
      const { root, path, store, write } = drafted();
      write('claude', [{ op: 'editPoint', id: 'p1', text: 'Waits run six days.' }, { op: 'editPoint', id: 'p2', text: 'Support is swamped.' }]);
      write('you', [{ op: 'editPoint', id: 'p1', text: 'Waits run six business days.' }, { op: 'addPoint', section: 's1', text: 'My own point.' }]);
      expect(store.changes(root, path)?.rows.map((r) => r.id)).toEqual(['p2']);
      write('claude', [{ op: 'editPoint', id: 'p1', text: 'Waits run a week.' }]);
      expect(store.changes(root, path)?.rows.map((r) => [r.id, r.was[0]])).toEqual([['p1', 'Waits are long.'], ['p2', 'Support is busy.']]);
    });

    it('clears on Mark reviewed, which tells the panel, and the next change starts from there', () => {
      const { root, path, store, write, changed } = drafted();
      write('claude', [{ op: 'editPoint', id: 'p1', text: 'Waits run six days.' }]);
      changed.length = 0;
      store.markReviewed(root, path);
      expect(store.changes(root, path)).toBeUndefined();
      expect(changed).toEqual([path]);
      write('claude', [{ op: 'removePoint', id: 'p1' }]);
      expect(store.changes(root, path)?.rows).toEqual([{ id: 'p1', row: 'point', change: 'removed', was: ['Waits run six days.'], section: 's1', after: null }]);
    });

    it('marks nothing for your own writes, or without a place to keep marks', () => {
      const { root, path, store, write } = drafted();
      write('you', [{ op: 'editPoint', id: 'p1', text: 'Mine.' }]);
      expect(store.changes(root, path)).toBeUndefined();
      const untracked = new OutlineStore();
      untracked.update(root, path, { version: untracked.read(root, path).version, ops: [{ op: 'removePoint', id: 'p2' }] }, 'claude');
      expect(untracked.changes(root, path)).toBeUndefined();
    });
  });
});
