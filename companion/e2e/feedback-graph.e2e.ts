import { expect, test } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { FeedbackDocument, FeedbackSnapResult } from '../src/protocol';
import { launchShown, RESULTS, sock, tempDataDir, type Launched } from './helpers';

let ctx: Launched;
test.afterEach(async () => { await ctx?.app.close(); });

const put = (cwd: string, rel: string, text: string) => {
  mkdirSync(dirname(join(cwd, rel)), { recursive: true });
  writeFileSync(join(cwd, rel), text);
};

const page = (color: string) =>
  `<!doctype html><html><head><title>Checkout</title><style>body{margin:0;font:16px sans-serif}#filters{width:300px;height:120px;margin:40px;background:${color}}</style></head><body><h1>Checkout</h1><div id="filters">Filters</div></body></html>`;

/** Width and height from a PNG's header. */
const pngSize = (file: string) => {
  const b = readFileSync(file);
  expect(b.subarray(1, 4).toString()).toBe('PNG');
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
};

async function agent(socketPath: string, route: string, ops: unknown[]) {
  const { body: doc } = await sock<FeedbackDocument>(socketPath, 'GET', route);
  const res = await sock(socketPath, 'POST', route, { version: doc.version, ops });
  expect(res.status).toBe(200);
}

test('snaps before and after pictures into a slider, and the graph opens items', async () => {
  const h = await launchShown();
  ctx = h.ctx;
  const { page: panel } = ctx;
  const cwd = tempDataDir();
  put(cwd, 'checkout.html', page('rgb(220, 40, 40)'));
  put(cwd, 'pricing.html', '<!doctype html><h1>Pricing</h1>');
  await sock(h.socketPath, 'POST', '/sessions', { sessionId: 'fg-1', cwd, title: 'Checkout' });
  await agent(h.socketPath, '/sessions/fg-1/feedback?path=pricing.html', [
    { op: 'addRound', label: 'SME', source: 'transcripts/sme-1.md' },
    { op: 'addItem', title: 'Plans hide the filters' },
  ]);
  await agent(h.socketPath, '/sessions/fg-1/feedback?path=checkout.html', [
    { op: 'addRound', label: 'SME', source: 'transcripts/sme-1.md' },
    { op: 'addItem', title: 'Hard to find the filters', lines: [{ key: 'Where', text: '#filters' }, { key: 'Related', text: 'pricing.html #1' }] },
    { op: 'addItem', title: 'Title is vague' },
    { op: 'addItem', title: 'Coupon field', lines: [{ key: 'Where', text: '#coupon' }] },
  ]);

  // The capture runs in a hidden window and crops to the element and its padding.
  const snap = (side: string) => sock<FeedbackSnapResult>(h.socketPath, 'POST', '/sessions/fg-1/feedback/snap?path=checkout.html', { item: 1, side });
  const before = await snap('before');
  expect(before.status).toBe(200);
  expect(before.body.picture).toBe('checkout.html.feedback/1-r1-before.png');
  const size = pngSize(join(cwd, before.body.picture));
  expect(size.width / size.height).toBeCloseTo(316 / 136, 1);
  put(cwd, 'checkout.html', page('rgb(40, 160, 90)'));
  expect((await snap('after')).status).toBe(200);
  const missing = await sock<{ error: string }>(h.socketPath, 'POST', '/sessions/fg-1/feedback/snap?path=checkout.html', { item: 3, side: 'before' });
  expect(missing).toMatchObject({ status: 400, body: { error: 'No element on the page matches #coupon' } });
  // Without a Where line it takes the visible page.
  const whole = await sock<FeedbackSnapResult>(h.socketPath, 'POST', '/sessions/fg-1/feedback/snap?path=pricing.html', { item: 1, side: 'before' });
  expect(whole.status).toBe(200);
  const view = pngSize(join(cwd, whole.body.picture));
  expect(view.width / view.height).toBeCloseTo(1280 / 800, 2);
  const lines = readFileSync(join(cwd, 'checkout.html.feedback.md'), 'utf8');
  expect(lines).toContain('    Before: checkout.html.feedback/1-r1-before.png\n    After: checkout.html.feedback/1-r1-after.png\n');

  await sock(h.socketPath, 'POST', '/open', { sessionId: 'fg-1', output: { path: 'checkout.html' } });
  await expect(panel.getByTestId('review')).toBeVisible();
  await panel.getByTestId('feedback-tab').click();
  const first = panel.getByTestId('feedback-item-1');
  const slider = first.getByTestId('feedback-slider');
  await expect(slider).toBeVisible();
  await expect(slider.locator('img')).toHaveCount(2);
  await expect(slider.locator('img.before')).toHaveAttribute('src', /^data:image\/png;base64,/);
  await slider.locator('input[type=range]').fill('30');
  await expect(slider).toHaveAttribute('style', /--split: 30%/);
  await expect(panel.getByTestId('feedback-item-2').getByTestId('feedback-pictures')).toHaveCount(0);
  await panel.screenshot({ path: join(RESULTS, 'feedback-slider.png') });

  // The graph links both outputs through the shared source and the Related line.
  await panel.getByTestId('feedback-graph-toggle').click();
  const graph = panel.getByTestId('feedback-graph');
  await expect(graph).toBeVisible();
  await expect(graph.getByTestId('graph-node')).toHaveCount(7);
  await expect(graph.locator('[data-kind="raised"]')).toHaveCount(4);
  await expect(graph.locator('[data-kind="related"]')).toHaveCount(1);
  await panel.screenshot({ path: join(RESULTS, 'feedback-graph.png') });

  await graph.locator('[data-id="item:checkout.html#2"]').click();
  await expect(graph).toHaveCount(0);
  await expect(panel.getByTestId('feedback-item-2')).toHaveClass(/focused/);

  await panel.getByTestId('feedback-graph-toggle').click();
  await panel.getByTestId('feedback-graph').locator('[data-id="item:pricing.html#1"]').click();
  const full = panel.getByTestId('feedback-view');
  await expect(full).toContainText('pricing.html');
  await expect(full.getByTestId('feedback-item-1')).toHaveClass(/focused/);
  await expect(full.getByTestId('feedback-item-1')).toContainText('Plans hide the filters');
  await expect(full.getByTestId('feedback-item-1').getByTestId('feedback-picture')).toContainText('Before');
});
