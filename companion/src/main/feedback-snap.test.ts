import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../server/testkit';
import { FeedbackStore } from './feedback';
import { FeedbackSnaps, type PageCapture } from './feedback-snap';

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

function setup() {
  const root = tempDir();
  mkdirSync(join(root, 'prototype'));
  writeFileSync(join(root, 'prototype/checkout.html'), '<div id="filters"></div>');
  writeFileSync(join(root, 'prd.md'), '# PRD');
  const store = new FeedbackStore(undefined, () => new Date(2026, 9, 18));
  const doc = store.update(root, 'prototype/checkout.html', { version: 'missing', ops: [
    { op: 'addRound', label: 'customers' },
    { op: 'addItem', title: 'Hard to find the filters', lines: [{ key: 'Where', text: '#filters' }] },
    { op: 'addItem', title: 'Whole page' },
    { op: 'addRound', label: 'SME' },
    { op: 'append', item: 1, key: 'Src', text: '2 · Maya · 00:14 · "Filters?"' },
  ] }, 'Claude');
  store.update(root, 'prd.md', { version: 'missing', ops: [{ op: 'addRound', label: 'SME' }, { op: 'addItem', title: 'Thin' }] }, 'Claude');
  const calls: [string, string | undefined][] = [];
  const capture: PageCapture = async (url, selector) => { calls.push([url, selector]); return PNG; };
  const snaps = new FeedbackSnaps({ store, urlFor: (_root, path) => `review://${path}`, capture });
  return { root, store, snaps, calls, doc };
}

describe('FeedbackSnaps', () => {
  it('captures the Where element into the sibling folder and appends one line per picture', async () => {
    const { root, snaps, calls } = setup();
    const res = await snaps.snap(root, 'prototype/checkout.html', { item: 1, side: 'before', round: 1 }, 'Claude');
    expect(res.picture).toBe('prototype/checkout.html.feedback/1-r1-before.png');
    expect(readFileSync(join(root, res.picture))).toEqual(PNG);
    expect(calls).toEqual([['review://prototype/checkout.html', '#filters']]);
    // The round defaults to the item's latest, and a retake keeps one line.
    await snaps.snap(root, 'prototype/checkout.html', { item: 1, side: 'after' }, 'Claude');
    const again = await snaps.snap(root, 'prototype/checkout.html', { item: 1, side: 'after' }, 'Claude');
    expect(again.items[0]!.after).toEqual(['checkout.html.feedback/1-r2-after.png']);
    const page = await snaps.snap(root, 'prototype/checkout.html', { item: 2, side: 'before' }, 'Claude');
    expect(page.picture).toBe('prototype/checkout.html.feedback/2-r1-before.png');
    expect(calls.at(-1)).toEqual(['review://prototype/checkout.html', undefined]);
    const text = readFileSync(join(root, 'prototype/checkout.html.feedback.md'), 'utf8');
    expect(text).toContain('    Before: checkout.html.feedback/1-r1-before.png\n    After: checkout.html.feedback/1-r2-after.png\n\n- [ ] #2');
    expect(text.match(/After:/g)).toHaveLength(1);
  });

  it('refuses non-HTML outputs, unknown items and rounds, and a linked assets folder', async () => {
    const { root, snaps, calls } = setup();
    await expect(snaps.snap(root, 'prd.md', { item: 1, side: 'before' }, 'Claude')).rejects.toThrow('Snapshots need an HTML output, and prd.md is not one');
    await expect(snaps.snap(root, 'prototype/checkout.html', { item: 9, side: 'before' }, 'Claude')).rejects.toThrow('has no item #9');
    await expect(snaps.snap(root, 'prototype/checkout.html', { item: 1, side: 'before', round: 7 }, 'Claude')).rejects.toThrow('There is no round 7');
    await expect(snaps.snap(root, 'prototype/checkout.html', { item: 1, side: 'sideways' }, 'Claude')).rejects.toThrow('Expected item');
    symlinkSync(tempDir(), join(root, 'prototype/checkout.html.feedback'));
    await expect(snaps.snap(root, 'prototype/checkout.html', { item: 1, side: 'before' }, 'Claude')).rejects.toThrow('must be a folder');
    expect(calls).toHaveLength(1);
  });

  it('reads a picture as a data URL from beside the output, and nothing outside it', async () => {
    const { root, snaps } = setup();
    await snaps.snap(root, 'prototype/checkout.html', { item: 1, side: 'before' }, 'Claude');
    expect(snaps.picture(root, 'prototype/checkout.html', 'checkout.html.feedback/1-r2-before.png')).toBe(`data:image/png;base64,${PNG.toString('base64')}`);
    expect(snaps.picture(root, 'prototype/checkout.html', 'checkout.html.feedback/1-r1-after.png')).toBeUndefined();
    for (const bad of ['../../outside.png', '.hidden/a.png', 'checkout.html.feedback/1-r2-before.txt', '/etc/a.png']) expect(() => snaps.picture(root, 'prototype/checkout.html', bad)).toThrow();
  });
});
