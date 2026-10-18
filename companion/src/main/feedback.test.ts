import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../server/testkit';
import { FeedbackStore } from './feedback';

const today = new Date(2026, 9, 18);

function setup() {
  const root = tempDir();
  mkdirSync(join(root, 'prototype'));
  writeFileSync(join(root, 'prototype/checkout.html'), '<div id="filters"></div>');
  writeFileSync(join(root, 'prd.md'), '# PRD');
  const store = new FeedbackStore(undefined, () => today);
  const doc = store.update(root, 'prototype/checkout.html', { version: 'missing', ops: [
    { op: 'addRound', label: 'customers', source: 'transcripts/cust-1.md' },
    { op: 'addItem', title: 'Hard to find the filters', lines: [{ key: 'Src', text: '1 · Ana · 03:02 · "Where do I filter?"' }, { key: 'Where', text: '#filters' }] },
  ] }, 'Claude');
  return { root, store, doc };
}

describe('feedback store', () => {
  it('creates the file beside the output and reads it back across stores', () => {
    const { root, doc } = setup();
    expect(doc).toMatchObject({ path: 'prototype/checkout.html.feedback.md', output: 'prototype/checkout.html', added: { rounds: [1], items: [1] } });
    expect(readFileSync(join(root, doc.path), 'utf8')).toContain('    Claude: 2026-10-18 · cataloged');
    const { added: _added, ...read } = doc;
    expect(new FeedbackStore().read(root, 'prototype/checkout.html')).toEqual(read);
  });

  it('answers an empty document for an output without feedback', () => {
    const { root, store } = setup();
    expect(store.read(root, 'prd.md')).toMatchObject({ version: 'missing', items: [], output: 'prd.md', path: 'prd.md.feedback.md' });
  });

  it('rejects stale writes, hand edits included', () => {
    const { root, store, doc } = setup();
    const next = store.update(root, 'prototype/checkout.html', { version: doc.version, ops: [{ op: 'append', item: 1, key: 'You', text: 'accept' }] }, 'You');
    expect(() => store.update(root, 'prototype/checkout.html', { version: doc.version, ops: [{ op: 'close', item: 1 }] }, 'Claude')).toThrow('changed since');
    writeFileSync(join(root, doc.path), readFileSync(join(root, doc.path), 'utf8') + '\n');
    expect(() => store.update(root, 'prototype/checkout.html', { version: next.version, ops: [{ op: 'close', item: 1 }] }, 'Claude')).toThrow('changed since');
    expect(store.read(root, 'prototype/checkout.html').items[0]!.state).toBe('accepted');
  });

  it('keeps each actor to its own lines and leaves the file alone on a bad op', () => {
    const { root, store, doc } = setup();
    const before = readFileSync(join(root, doc.path), 'utf8');
    expect(() => store.update(root, 'prototype/checkout.html', { version: doc.version, ops: [{ op: 'append', item: 1, key: 'Change', text: 'Fine' }, { op: 'append', item: 1, key: 'You', text: 'accept' }] }, 'Claude')).toThrow('Only the user');
    expect(readFileSync(join(root, doc.path), 'utf8')).toBe(before);
  });

  it('notifies on writes', () => {
    const root = tempDir();
    writeFileSync(join(root, 'a.md'), 'x');
    let changes = 0;
    const store = new FeedbackStore(() => changes++);
    store.update(root, 'a.md', { version: 'missing', ops: [{ op: 'addRound', label: 'SME' }] }, 'Claude');
    expect(changes).toBe(1);
  });

  it('refuses traversal, dot folders, symlinks out and feedback files as outputs', () => {
    const { root, store } = setup();
    const outside = tempDir();
    writeFileSync(join(outside, 'page.html'), '<h1>Outside</h1>');
    symlinkSync(join(outside, 'page.html'), join(root, 'escape.html'));
    writeFileSync(join(root, 'other.md'), '# Other');
    symlinkSync(join(outside, 'page.html'), join(root, 'other.md.feedback.md'));
    mkdirSync(join(root, '.private'));
    writeFileSync(join(root, '.private/a.md'), 'x');
    for (const path of ['../page.html', join(outside, 'page.html'), 'escape.html', 'other.md', '.private/a.md', 'missing.md', 'prototype/checkout.html.feedback.md']) expect(() => store.read(root, path)).toThrow();
  });

  it('lists the project files with counts, skipping dot folders and node_modules', () => {
    const { root, store, doc } = setup();
    store.update(root, 'prototype/checkout.html', { version: doc.version, ops: [{ op: 'addItem', title: 'Pay button is low' }, { op: 'append', item: 1, key: 'Claude', text: 'done' }] }, 'Claude');
    for (const dir of ['node_modules', '.git']) {
      mkdirSync(join(root, dir));
      writeFileSync(join(root, dir, 'x.md.feedback.md'), '# Feedback · x.md\n');
    }
    writeFileSync(join(root, 'gone.md.feedback.md'), '# Feedback · gone.md\n');
    expect(store.project(root)).toMatchObject({ files: [
      { path: 'gone.md.feedback.md', output: 'gone.md', outputExists: false, title: 'Feedback · gone.md', rounds: 0, items: 0, open: 0, accepted: 0, rejected: 0, done: 0 },
      { path: 'prototype/checkout.html.feedback.md', output: 'prototype/checkout.html', outputExists: true, title: 'Feedback · checkout.html', rounds: 1, items: 2, open: 1, accepted: 0, rejected: 0, done: 1 },
    ] });
  });
});
