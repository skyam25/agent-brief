import { expect, test } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { BoardsResponse, FeedbackDocument, OutputRecord, ReadResponse } from '../src/protocol';
import { isoDate } from '../src/shared/feedback';
import { shortDate } from '../src/shared/feedback-workspace';
import { deliveriesFor, launchShown, RESULTS, sock, tempDataDir, type Launched } from './helpers';

let ctx: Launched;
test.afterEach(async () => { await ctx?.app.close(); });

const put = (cwd: string, rel: string, text: string) => {
  mkdirSync(dirname(join(cwd, rel)), { recursive: true });
  writeFileSync(join(cwd, rel), text);
};

/** Claude's writes, over the socket as the CLI makes them. */
async function agent(socketPath: string, route: string, ops: unknown[]) {
  const { body: doc } = await sock<FeedbackDocument>(socketPath, 'GET', route);
  const res = await sock(socketPath, 'POST', route, { version: doc.version, ops });
  expect(res.status).toBe(200);
}

const PAGE = '<!doctype html><html><head><title>Checkout</title></head><body><h1>Checkout</h1><div id="filters" style="width:320px;height:60px;background:#c4b5fd">Filters</div><p>Results</p></body></html>';

test('opens an item workspace over the page, saves it to the item, and reopens the same board', async () => {
  const h = await launchShown();
  ctx = h.ctx;
  const { page } = ctx;
  const cwd = tempDataDir();
  put(cwd, 'checkout.html', PAGE);
  await sock(h.socketPath, 'POST', '/sessions', { sessionId: 'ws-1', cwd, title: 'Checkout' });
  const route = '/sessions/ws-1/feedback?path=checkout.html';
  await agent(h.socketPath, route, [
    { op: 'addRound', label: 'customers' },
    { op: 'addItem', title: 'Hard to find the filters', lines: [{ key: 'Src', text: '1 · Ana · 03:02 · "Where do I filter?"' }, { key: 'Change', text: 'Move the filter row above the results.' }, { key: 'Where', text: '#filters' }] },
  ]);
  await sock(h.socketPath, 'POST', '/open', { sessionId: 'ws-1', output: { path: 'checkout.html' } });
  await expect(page.getByTestId('review')).toBeVisible();
  await page.getByTestId('feedback-tab').click();
  const card = page.getByTestId('feedback-item-1');
  await card.getByTestId('feedback-note').fill('check mobile too');
  await card.getByTestId('feedback-note').press('Enter');
  await expect(card.getByTestId('feedback-note')).toHaveValue('');
  await expect(card.getByTestId('feedback-workspace-summary')).toHaveCount(0);

  // The layer covers the page with the item's board, seeded with its frame, quote and element.
  await card.getByTestId('feedback-workspace-open').click();
  const layer = page.getByTestId('workspace-layer');
  await expect(layer).toBeVisible();
  await expect(layer.getByTestId('workspace-board')).toHaveText('fb-checkout-1');
  await expect(layer).toContainText('Hard to find the filters');
  await expect(layer).toContainText('Where do I filter?');
  await expect(layer.getByTestId('workspace-rail-entry')).toHaveText([/Note · .*check mobile too/]);
  const canvas = layer.locator('canvas.excalidraw__canvas.interactive');
  await expect(canvas).toBeVisible();
  const read = async () => (await sock<ReadResponse>(h.socketPath, 'GET', '/boards/fb-checkout-1/elements')).body.elements;
  await expect.poll(async () => (await read()).map((e) => e.type).sort()).toEqual(['frame', 'image', 'sticky']);
  const seeded = await read();
  expect(seeded.find((e) => e.type === 'frame')!.label).toBe('Round 1');
  expect(seeded.find((e) => e.type === 'sticky')!.label).toContain('"Where do I filter?" — Ana');
  const frameId = seeded.find((e) => e.type === 'frame')!.id;
  expect(seeded.find((e) => e.type === 'image')!.frameId).toBe(frameId);

  // The board stays out of the board lists.
  const { body: listed } = await sock<BoardsResponse>(h.socketPath, 'GET', '/boards');
  expect(listed.boards.map((b) => b.name)).not.toContain('fb-checkout-1');

  // Claude draws on the open workspace, then the user draws a box beside it.
  const drawn = await sock(h.socketPath, 'POST', '/boards/fb-checkout-1/draw', { elements: [{ type: 'sticky', x: 1300, y: 0, label: 'Option B: sticky filters' }] });
  expect(drawn.status).toBe(200);
  await expect.poll(async () => (await read()).some((e) => e.label === 'Option B: sticky filters')).toBe(true);
  await page.screenshot({ path: join(RESULTS, 'feedback-workspace-seeded.png') });
  const box = (await canvas.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.press('r');
  await page.mouse.move(box.x + box.width / 2 - 60, box.y + box.height / 2 - 40);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2 + 40, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await read()).filter((e) => e.by === 'user').length).toBe(1);
  await expect(page.getByTestId('review-edit')).toHaveAttribute('aria-pressed', 'false');
  await page.screenshot({ path: join(RESULTS, 'feedback-workspace.png') });

  // Save exports the PNG and logs it on the item. Nothing goes to Claude.
  await layer.getByTestId('workspace-save').click();
  const file = join(cwd, 'checkout.html.feedback.md');
  const today = isoDate(new Date());
  await expect.poll(() => readFileSync(file, 'utf8')).toContain(`    Workspace: ${today} · saved · fb-checkout-1 · checkout.html.feedback/1-workspace.png\n`);
  const png = join(cwd, 'checkout.html.feedback/1-workspace.png');
  expect(existsSync(png)).toBe(true);
  expect(readFileSync(png).subarray(1, 4).toString()).toBe('PNG');
  await expect(layer.getByTestId('workspace-saved')).toHaveText(`Workspace · saved ${shortDate(today)}`);
  expect(await deliveriesFor(h.socketPath, 'ws-1')).toHaveLength(0);

  await layer.getByTestId('workspace-back').click();
  await expect(layer).toHaveCount(0);
  await expect(card.getByTestId('feedback-workspace-summary')).toHaveText(`Workspace · saved ${shortDate(today)}`);

  // Raised again in round 2: the same board keeps round 1 and gains a frame.
  await agent(h.socketPath, route, [{ op: 'addRound', label: 'SME' }, { op: 'append', item: 1, key: 'Src', text: '2 · Maya · 00:14 · "I couldn\'t find the filters"' }]);
  await card.getByTestId('feedback-workspace-open').click();
  await expect(layer.getByTestId('workspace-board')).toHaveText('fb-checkout-1');
  await expect(layer).toContainText("I couldn't find the filters");
  await expect.poll(async () => (await read()).filter((e) => e.type === 'frame').map((e) => e.label)).toEqual(['Round 1', 'Round 2']);
  const reopened = await read();
  expect(reopened.find((e) => e.id === frameId)?.label).toBe('Round 1');
  expect(reopened.some((e) => e.label === 'Option B: sticky filters')).toBe(true);
  expect(reopened.filter((e) => e.by === 'user')).toHaveLength(1);
  await layer.getByTestId('workspace-back').click();
  await card.getByTestId('feedback-workspace-open').click();
  await expect(layer.getByTestId('workspace-board')).toHaveText('fb-checkout-1');
  expect((await read()).filter((e) => e.type === 'frame')).toHaveLength(2);
});

test('opens a workspace over the full-width feedback view', async () => {
  const h = await launchShown();
  ctx = h.ctx;
  const { page } = ctx;
  const cwd = tempDataDir();
  put(cwd, 'docs/prd.md', '# PRD\n\n## Pricing\n');
  const now = Date.now();
  const prd: OutputRecord = { ref: 'docs/prd.md', title: 'PRD', kind: 'markdown', tier: 'declared', status: 'ready', declaredAt: now, firstWriteAt: now, lastWriteAt: now, writes: 1 };
  put(cwd, '.feedback/outputs/ws-2.json', JSON.stringify({ version: 1, sessionId: 'ws-2', outputs: [prd] }));
  await sock(h.socketPath, 'POST', '/sessions', { sessionId: 'ws-2', cwd, title: 'PRD' });
  await agent(h.socketPath, '/sessions/ws-2/feedback?path=docs/prd.md', [
    { op: 'addRound', label: 'SME' },
    { op: 'addItem', title: 'Pricing section is thin', lines: [{ key: 'Where', text: '## Pricing' }] },
  ]);
  await sock(h.socketPath, 'POST', '/open', { sessionId: 'ws-2' });
  await page.getByTestId('mode-review').click();
  await page.getByTestId('output-feedback-0').click();
  const view = page.getByTestId('feedback-view');
  await view.getByTestId('feedback-workspace-open').click();
  const layer = view.getByTestId('workspace-layer');
  await expect(layer.getByTestId('workspace-board')).toHaveText('fb-prd-1');
  await expect(layer.locator('canvas.excalidraw__canvas.interactive')).toBeVisible();
  const { body } = await sock<ReadResponse>(h.socketPath, 'GET', '/boards/fb-prd-1/elements');
  expect(body.elements.map((e) => e.type).sort()).toEqual(['frame', 'sticky']);
  await page.screenshot({ path: join(RESULTS, 'feedback-workspace-full.png') });
  await layer.getByTestId('workspace-back').click();
  await expect(view.getByTestId('feedback-panel')).toBeVisible();
});
