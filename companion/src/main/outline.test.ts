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
});
