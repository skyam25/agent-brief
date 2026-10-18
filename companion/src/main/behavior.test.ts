import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BehaviorRule } from '../protocol';
import { tempDir } from '../server/testkit';
import { BehaviorStore } from './behavior';

const rule = (id = 'back'): BehaviorRule => ({ id, text: 'Back preserves entered addresses.', status: 'proposed', source: { kind: 'assumption', ref: 'Not specified in the brief' }, delivery: 'planned', target: { selector: '[data-ui="back"]' } });
function setup() {
  const root = tempDir();
  writeFileSync(join(root, 'mock.html'), '<button data-ui="back">Back</button>');
  const store = new BehaviorStore();
  const doc = store.update(root, 'mock.html', { version: 'missing', upsert: [rule()], limitations: ['Sending is simulated'] }, 'Agent · a');
  return { root, store, doc };
}

describe('behavior specifications', () => {
  it('persists PM decisions and their source across store restarts', () => {
    const { root, store, doc } = setup();
    const confirmed = store.decide(root, 'mock.html', { version: doc.version, id: 'back', text: rule().text, status: 'confirmed' });
    const reopened = new BehaviorStore().read(root, 'mock.html');
    expect(reopened).toEqual(confirmed);
    expect(reopened.rules[0]).toMatchObject({ status: 'confirmed', delivery: 'planned', source: { kind: 'decision' } });
    expect(reopened.history[1]).toMatchObject({ by: 'PM', before: [{ status: 'proposed' }], after: [{ status: 'confirmed' }] });
  });

  it('rejects stale agent and PM writes, including hand edits without a revision bump', () => {
    const { root, store, doc } = setup();
    const confirmed = store.decide(root, 'mock.html', { version: doc.version, id: 'back', text: rule().text, status: 'confirmed' });
    expect(() => store.update(root, 'mock.html', { version: doc.version, upsert: [rule()] }, 'Agent')).toThrow('changed since');
    expect(() => store.decide(root, 'mock.html', { version: doc.version, id: 'back', text: 'Discard', status: 'confirmed' })).toThrow('changed since');
    writeFileSync(join(root, confirmed.path), readFileSync(join(root, confirmed.path), 'utf8') + '\n');
    expect(() => store.update(root, 'mock.html', { version: confirmed.version, limitations: [] }, 'Agent')).toThrow('changed since');
    expect(store.read(root, 'mock.html').rules[0].status).toBe('confirmed');
  });

  it('returns changed confirmed behavior to proposed and clears verification evidence', () => {
    const { root, store, doc } = setup();
    const confirmed = store.decide(root, 'mock.html', { version: doc.version, id: 'back', text: rule().text, status: 'confirmed' });
    const verified = store.update(root, 'mock.html', { version: confirmed.version, upsert: [{ ...confirmed.rules[0], delivery: 'verified', evidence: 'navigation.test.ts passed' }] }, 'Agent');
    const changed = store.update(root, 'mock.html', { version: verified.version, upsert: [{ ...verified.rules[0], text: 'Back discards entered addresses.' }] }, 'Agent');
    expect(changed.rules[0]).toMatchObject({ status: 'proposed', delivery: 'planned' });
    expect(changed.rules[0].evidence).toBeUndefined();
    expect(changed.history.at(-1)?.before[0].delivery).toBe('verified');
  });

  it('does not let agents confirm an existing proposal, and upserts preserve other rules', () => {
    const { root, store, doc } = setup();
    const updated = store.update(root, 'mock.html', { version: doc.version, upsert: [{ ...rule(), status: 'confirmed', source: { kind: 'brief', ref: 'brief.md' } }, rule('skip')] }, 'Agent');
    expect(updated.rules.map((r) => [r.id, r.status])).toEqual([['back', 'proposed'], ['skip', 'proposed']]);
    expect(updated.limitations).toEqual(doc.limitations);
  });

  it('requires evidence for verification and rejects malformed or duplicate rules', () => {
    const { root, store, doc } = setup();
    for (const upsert of [[{ ...rule(), delivery: 'verified' }], [rule(), rule()], [{ ...rule(), source: null }]]) {
      expect(() => store.update(root, 'mock.html', { version: doc.version, upsert }, 'Agent')).toThrow();
    }
    expect(store.read(root, 'mock.html').version).toBe(doc.version);
  });

  it('refuses traversal and prototype or sidecar symlinks outside the project', () => {
    const { root, store } = setup();
    const outside = tempDir();
    writeFileSync(join(outside, 'page.html'), '<h1>Outside</h1>');
    symlinkSync(join(outside, 'page.html'), join(root, 'escape.html'));
    writeFileSync(join(root, 'other.html'), '<h1>Other</h1>');
    symlinkSync(join(outside, 'page.html'), join(root, 'other.html.behavior.json'));
    mkdirSync(join(root, '.private'));
    for (const path of ['../page.html', join(outside, 'page.html'), 'escape.html', 'other.html', '.private/mock.html']) expect(() => store.read(root, path)).toThrow();
    expect(readFileSync(join(outside, 'page.html'), 'utf8')).toBe('<h1>Outside</h1>');
  });

  it('reports damaged files rather than replacing decisions with an empty document', () => {
    const { root, store, doc } = setup();
    writeFileSync(join(root, doc.path), '{bad');
    expect(() => store.update(root, 'mock.html', { version: 'missing', upsert: [rule()] }, 'Agent')).toThrow('Invalid behavior specification');
    expect(readFileSync(join(root, doc.path), 'utf8')).toBe('{bad');
  });
});
