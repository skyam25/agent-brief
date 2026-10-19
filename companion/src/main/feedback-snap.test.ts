import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
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
  const capture: PageCapture = async (url, selector) => { calls.push([url, selector]); return { png: PNG }; };
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
    // The round defaults to the item's latest.
    await snaps.snap(root, 'prototype/checkout.html', { item: 1, side: 'after' }, 'Claude');
    const page = await snaps.snap(root, 'prototype/checkout.html', { item: 2, side: 'before' }, 'Claude');
    expect(page.picture).toBe('prototype/checkout.html.feedback/2-r1-before.png');
    expect(calls.at(-1)).toEqual(['review://prototype/checkout.html', undefined]);
    const text = readFileSync(join(root, 'prototype/checkout.html.feedback.md'), 'utf8');
    expect(text).toContain('    Before: checkout.html.feedback/1-r1-before.png\n    After: checkout.html.feedback/1-r2-after.png\n\n- [ ] #2');
    expect(text.match(/After:/g)).toHaveLength(1);
  });

  it('keeps every picture: a retake writes a new revision and its own line', async () => {
    const { root, store } = setup();
    let bytes = Buffer.from('old');
    const snaps = new FeedbackSnaps({ store, urlFor: () => 'review://x', capture: async () => ({ png: bytes }) });
    const at = (p: string) => readFileSync(join(root, 'prototype', p), 'utf8');
    await snaps.snap(root, 'prototype/checkout.html', { item: 1, side: 'before', round: 1 }, 'Claude');
    bytes = Buffer.from('new');
    const again = await snaps.snap(root, 'prototype/checkout.html', { item: 1, side: 'before', round: 1 }, 'Claude');
    expect(again.picture).toBe('prototype/checkout.html.feedback/1-r1-before-2.png');
    expect(at('checkout.html.feedback/1-r1-before.png')).toBe('old');
    expect(at('checkout.html.feedback/1-r1-before-2.png')).toBe('new');
    // A stray file at the next name is never replaced.
    writeFileSync(join(root, 'prototype/checkout.html.feedback/1-r1-after.png'), 'stray');
    const after = await snaps.snap(root, 'prototype/checkout.html', { item: 1, side: 'after', round: 1 }, 'Claude');
    expect(after.picture).toBe('prototype/checkout.html.feedback/1-r1-after-2.png');
    expect(at('checkout.html.feedback/1-r1-after.png')).toBe('stray');
    expect(after.items[0]!.before).toEqual(['checkout.html.feedback/1-r1-before.png', 'checkout.html.feedback/1-r1-before-2.png']);
    expect(after.items[0]!.after).toEqual(['checkout.html.feedback/1-r1-after-2.png']);
  });

  it('says in the line when the page was clipped', async () => {
    const { root, store } = setup();
    const snaps = new FeedbackSnaps({ store, urlFor: () => 'review://x', capture: async () => ({ png: PNG, clipped: 10_000 }) });
    const res = await snaps.snap(root, 'prototype/checkout.html', { item: 2, side: 'before' }, 'Claude');
    expect(res.clipped).toBe(10_000);
    expect(res.items[1]!.before).toEqual(['checkout.html.feedback/2-r1-before.png · clipped to the top 10000px']);
  });

  it('checks the folders again after the capture, and writes nothing when a parent was swapped', async () => {
    for (const into of ['outside', 'inside'] as const) {
      const { root, store } = setup();
      const elsewhere = into === 'outside' ? tempDir() : join(root, 'other');
      mkdirSync(elsewhere, { recursive: true });
      writeFileSync(join(elsewhere, 'checkout.html'), '<div id="filters"></div>');
      const capture: PageCapture = async () => {
        renameSync(join(root, 'prototype'), join(root, 'old'));
        symlinkSync(elsewhere, join(root, 'prototype'));
        return { png: PNG };
      };
      const snaps = new FeedbackSnaps({ store, urlFor: () => 'review://x', capture });
      await expect(snaps.snap(root, 'prototype/checkout.html', { item: 1, side: 'before' }, 'Claude')).rejects.toThrow(into === 'outside' ? 'Output must be a file inside the project' : 'moved while');
      expect(readdirSync(elsewhere)).toEqual(['checkout.html']);
      expect(existsSync(join(root, 'old/checkout.html.feedback'))).toBe(false);
    }
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
    for (const bad of ['../../outside.png', '.hidden/a.png', 'checkout.html.feedback/1-r2-before.txt', '/etc/a.png', 'a\nb.png']) expect(() => snaps.picture(root, 'prototype/checkout.html', bad)).toThrow();
    // An alias into a dot folder is refused on its canonical path.
    mkdirSync(join(root, '.hidden'));
    writeFileSync(join(root, '.hidden/a.png'), PNG);
    symlinkSync(join(root, '.hidden/a.png'), join(root, 'prototype/checkout.html.feedback/alias.png'));
    expect(() => snaps.picture(root, 'prototype/checkout.html', 'checkout.html.feedback/alias.png')).toThrow();
  });
});
