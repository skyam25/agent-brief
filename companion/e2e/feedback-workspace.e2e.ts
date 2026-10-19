import { expect, test, type Locator, type Page } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { BoardsResponse, FeedbackDocument, OutputRecord, ReadResponse } from '../src/protocol';
import { isoDate } from '../src/shared/feedback';
import { shortDate } from '../src/shared/feedback-workspace';
import { deliveriesFor, launch, launchShown, ROOT, RESULTS, showPanel, sock, tempDataDir, type Launched } from './helpers';

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
  // An ordinary board whose name happens to start with fb- predates any feedback.
  await ctx.app.evaluate(() => globalThis.__companion.store.create('fb-planning'));
  const route = '/sessions/ws-1/feedback?path=checkout.html';
  await agent(h.socketPath, route, [
    { op: 'addRound', label: 'customers' },
    { op: 'addItem', title: 'Hard to find the filters', lines: [{ key: 'Src', text: '1 · Ana · 03:02 · "Where do I filter?"' }, { key: 'Change', text: 'Move the filter row above the results.' }, { key: 'Where', text: '#filters' }] },
  ]);
  const read = async () => (await sock<ReadResponse>(h.socketPath, 'GET', '/boards/fb-checkout-1/elements')).body.elements;

  // Claude opens the workspace first, from the CLI, so it has no picture of the page yet.
  const viaCli = await sock(h.socketPath, 'POST', '/sessions/ws-1/feedback/workspace?path=checkout.html&item=1');
  expect(viaCli.status).toBe(200);
  expect((await read()).map((e) => e.type).sort()).toEqual(['frame', 'sticky']);
  await sock(h.socketPath, 'POST', '/open', { sessionId: 'ws-1', output: { path: 'checkout.html' } });
  await expect(page.getByTestId('review')).toBeVisible();
  await page.getByTestId('feedback-tab').click();
  const card = page.getByTestId('feedback-item-1');
  await card.getByTestId('feedback-expand').click();
  await card.getByTestId('feedback-note').fill('check mobile too');
  await card.getByTestId('feedback-note').press('Enter');
  await expect(card.getByTestId('feedback-note')).toHaveValue('');
  await expect(card.getByTestId('feedback-workspace-summary')).toHaveCount(0);

  // The layer covers the page with the item's board. Its frame gains the element's picture.
  await card.getByTestId('feedback-workspace-open').click();
  const layer = page.getByTestId('workspace-layer');
  await expect(layer).toBeVisible();
  await expect(layer.getByTestId('workspace-board')).toHaveText('fb-checkout-1');
  await expect(layer).toContainText('Hard to find the filters');
  await expect(layer).toContainText('Where do I filter?');
  await expect(layer.getByTestId('workspace-rail-entry')).toHaveText([/Note · .*check mobile too/]);
  const canvas = layer.locator('canvas.excalidraw__canvas.interactive');
  await expect(canvas).toBeVisible();
  await expect.poll(async () => (await read()).map((e) => e.type).sort()).toEqual(['frame', 'image', 'sticky']);
  const seeded = await read();
  expect(seeded.find((e) => e.type === 'frame')!.label).toBe('Round 1');
  expect(seeded.find((e) => e.type === 'sticky')!.label).toContain('"Where do I filter?" — Ana');
  const frameId = seeded.find((e) => e.type === 'frame')!.id;
  expect(seeded.find((e) => e.type === 'image')!.frameId).toBe(frameId);

  // The socket lists every board. The panel's lists leave out only the bound workspace.
  const { body: listed } = await sock<BoardsResponse>(h.socketPath, 'GET', '/boards');
  expect(listed.boards.map((b) => b.name)).toEqual(expect.arrayContaining(['fb-checkout-1', 'fb-planning']));
  const panelBoards = await page.evaluate(async () => (await (window as unknown as { companion: { listBoards(): Promise<{ name: string }[]> } }).companion.listBoards()).map((b) => b.name));
  expect(panelBoards).toContain('fb-planning');
  expect(panelBoards).not.toContain('fb-checkout-1');

  // Claude draws on the open workspace, then the user draws a box beside it.
  const drawn = await sock(h.socketPath, 'POST', '/boards/fb-checkout-1/draw', { elements: [{ type: 'sticky', x: 1300, y: 0, label: 'Option B: sticky filters' }] });
  expect(drawn.status).toBe(200);
  await expect.poll(async () => (await read()).some((e) => e.label === 'Option B: sticky filters')).toBe(true);
  await page.screenshot({ path: join(RESULTS, 'feedback-workspace-seeded.png') });
  // An overall note opens the comment column first, so the canvas keeps its size from here on.
  await layer.getByTestId('comment-tool').click();
  await layer.getByTestId('board-overall').fill('Option B reads better');
  await layer.getByTestId('comment-tool').click();
  await expect(layer.getByTestId('comment-tool')).toHaveAttribute('aria-pressed', 'false');
  await expect(layer.getByTestId('board-comments')).toBeVisible();
  const box = (await canvas.boundingBox())!;
  const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.click(at.x, at.y);
  await page.keyboard.press('r');
  await page.mouse.move(at.x - 60, at.y - 40);
  await page.mouse.down();
  await page.mouse.move(at.x + 40, at.y + 40, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await read()).filter((e) => e.by === 'user').length).toBe(1);
  await expect(page.getByTestId('review-edit')).toHaveAttribute('aria-pressed', 'false');

  // The user pins a comment. The pin and the overall note outlast leaving the layer.
  await layer.getByTestId('comment-tool').click();
  const view = (await canvas.boundingBox())!;
  await page.mouse.click(view.x + view.width / 2, view.y + view.height / 2);
  await expect(layer.getByTestId('board-comment-card')).toHaveCount(1);
  await layer.getByTestId('board-comment-text').fill('make it bigger');
  await page.screenshot({ path: join(RESULTS, 'feedback-workspace.png') });
  await layer.getByTestId('workspace-back').click();
  await card.getByTestId('feedback-workspace-open').click();
  await expect(layer.getByTestId('board-comment-text')).toHaveValue('make it bigger');
  await expect(layer.getByTestId('board-overall')).toHaveValue('Option B reads better');
  await expect(layer.getByTestId('board-pin')).toHaveCount(1);

  // Save exports the PNG and logs it, the pin and the note on the item. Nothing goes to Claude.
  await layer.getByTestId('workspace-save').click();
  const file = join(cwd, 'checkout.html.feedback.md');
  const today = isoDate(new Date());
  const saved = new RegExp(
    [
      `    You: ${today} · note · pin 1 on .+ · make it bigger`,
      `    You: ${today} · note · Option B reads better`,
      `    Workspace: ${today} · saved · fb-checkout-1 · checkout\\.html\\.feedback/1-workspace-1\\.png`,
      '',
    ].join('\n'),
  );
  await expect.poll(() => readFileSync(file, 'utf8')).toMatch(saved);
  const png = join(cwd, 'checkout.html.feedback/1-workspace-1.png');
  expect(existsSync(png)).toBe(true);
  expect(readFileSync(png).subarray(1, 4).toString()).toBe('PNG');
  // The pin reads on the whole picture, and a strip under it lists the pin's words.
  writeFileSync(join(RESULTS, 'feedback-workspace-saved.png'), readFileSync(png));
  const violet = await violetPixels(page, readFileSync(png));
  expect(violet.above).toBeGreaterThan(28 * 28 * 0.6);
  expect(violet.strip).toBeGreaterThan(28 * 28 * 0.6);
  await expect(layer.getByTestId('workspace-saved')).toHaveText(`Workspace · saved ${shortDate(today)}`);
  await expect(layer.getByTestId('board-comment-card')).toHaveCount(0);
  await expect(layer.getByTestId('board-overall')).toHaveValue('');
  await expect(layer.getByTestId('board-pin')).toHaveCount(0);
  await expect(layer.getByTestId('workspace-rail-entry')).toHaveText([/check mobile too/, /pin 1 on .+ · make it bigger/, /Option B reads better/]);
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

  // A second Save keeps the first picture and names a new one.
  await layer.getByTestId('workspace-save').click();
  await expect.poll(() => readFileSync(file, 'utf8')).toContain(`    Workspace: ${today} · saved · fb-checkout-1 · checkout.html.feedback/1-workspace-2.png\n`);
  expect(existsSync(png)).toBe(true);
  expect(existsSync(join(cwd, 'checkout.html.feedback/1-workspace-2.png'))).toBe(true);
});

/** Pin-violet pixels in a PNG: above its bottom 130 rows, where the board is, and in them, where the legend is. */
const violetPixels = (page: Page, png: Buffer) =>
  page.evaluate(async (data) => {
    const img = new Image();
    img.src = `data:image/png;base64,${data}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    const px = ctx.getImageData(0, 0, c.width, c.height).data;
    const near = (i: number) => Math.abs(px[i]! - 0x69) < 14 && Math.abs(px[i + 1]! - 0x65) < 14 && Math.abs(px[i + 2]! - 0xdb) < 14;
    const out = { above: 0, strip: 0 };
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) if (near((y * c.width + x) * 4)) out[y < c.height - 130 ? 'above' : 'strip']++;
    return out;
  }, png.toString('base64'));

/** Where the header's parts sit: whether any part drops below the first row, and whether Save shows whole. */
const headLayout = (layer: Locator) =>
  layer.locator('.workspace-head').evaluate((head) => {
    const box = head.getBoundingClientRect();
    const parts = [...head.children].map((c) => c.getBoundingClientRect()).filter((r) => r.width > 0);
    const save = head.querySelector('[data-testid="workspace-save"]')!.getBoundingClientRect();
    return {
      height: Math.round(box.height),
      wraps: parts.some((r) => r.top >= box.top + box.height / 2),
      saveShown: save.width > 0 && save.right <= box.right + 0.5 && save.top >= box.top && save.bottom <= box.bottom,
      quoteCut: (() => {
        const q = head.querySelector<HTMLElement>('.workspace-quote');
        return !!q && q.scrollWidth > q.clientWidth;
      })(),
    };
  });

test('the layer keeps one column and a one-line header, and hides the panel footer', async () => {
  const h = await launchShown();
  ctx = h.ctx;
  const { app, page } = ctx;
  await app.evaluate(() => globalThis.__companion.panel.win.setSize(1400, 900));
  const cwd = tempDataDir();
  put(cwd, 'checkout.html', PAGE);
  await sock(h.socketPath, 'POST', '/sessions', { sessionId: 'ws-5', cwd, title: 'Checkout' });
  const quote = "I couldn't find the filters. They should be above the products, not buried below where nobody scrolls";
  await agent(h.socketPath, '/sessions/ws-5/feedback?path=checkout.html', [
    { op: 'addRound', label: 'customers' },
    { op: 'addItem', title: "Couldn't find the filter", lines: [{ key: 'Src', text: `1 · Maya · 00:14 · "${quote}"` }, { key: 'Where', text: '#filters' }] },
  ]);
  await sock(h.socketPath, 'POST', '/open', { sessionId: 'ws-5', output: { path: 'checkout.html' } });
  await page.getByTestId('feedback-tab').click();
  const card = page.getByTestId('feedback-item-1');
  await card.getByTestId('feedback-note').fill('chips, not a dropdown');
  await card.getByTestId('feedback-note').press('Enter');
  await expect(card.getByTestId('feedback-note')).toHaveValue('');
  await expect(page.getByTestId('composer')).toBeVisible();
  await card.getByTestId('feedback-workspace-open').click();
  const layer = page.getByTestId('workspace-layer');
  await expect(layer.locator('canvas.excalidraw__canvas.interactive')).toBeVisible();

  // Save to #N is the layer's only commit, so the panel's footer hides while it shows.
  await expect(page.getByTestId('composer')).toBeHidden();

  // One column: the unsaved overall note and pins first, then what the item already has.
  await expect(layer.locator('aside')).toHaveCount(1);
  const column = layer.getByTestId('board-comments');
  await expect(column).toBeVisible();
  await expect(column.getByTestId('workspace-rail-entry')).toHaveText([/chips, not a dropdown/]);
  await expect(column.getByTestId('workspace-board')).toHaveText('fb-checkout-1');
  const overallFirst = await column.evaluate((c) => {
    const overall = c.querySelector('[data-testid="board-overall"]')!;
    const saved = c.querySelector('[data-testid="workspace-rail-entry"]')!;
    return !!(overall.compareDocumentPosition(saved) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  expect(overallFirst).toBe(true);

  // The header never wraps. The quote truncates and Save stays on the first line, with the sessions and the list open.
  if ((await page.getByTestId('sidebar-toggle').getAttribute('aria-pressed')) !== 'true') await page.getByTestId('sidebar-toggle').click();
  for (const [width, height] of [[1400, 900], [1100, 800], [1000, 800]] as const) {
    await app.evaluate((_e, size) => globalThis.__companion.panel.win.setSize(size[0], size[1]), [width, height] as const);
    for (const list of [false, true]) {
      const toggle = page.getByTestId('review-list-toggle');
      if ((await toggle.getAttribute('aria-pressed')) !== String(list)) await toggle.click();
      await expect(toggle).toHaveAttribute('aria-pressed', String(list));
      await page.waitForTimeout(100);
      const at = `${width}×${height}${list ? ' with the list' : ''}`;
      expect(await headLayout(layer), at).toMatchObject({ wraps: false, saveShown: true, quoteCut: true });
      expect((await headLayout(layer)).height, at).toBeLessThanOrEqual(56);
      await page.screenshot({ path: join(RESULTS, `feedback-workspace-${width}${list ? '-list' : ''}.png`) });
    }
  }

  await layer.getByTestId('workspace-back').click();
  await expect(layer).toHaveCount(0);
  await expect(page.getByTestId('composer')).toBeVisible();
});

test('Add to note opens one Write note linked to the item', async () => {
  const h = await launchShown();
  ctx = h.ctx;
  const { page } = ctx;
  const cwd = tempDataDir();
  put(cwd, 'checkout.html', PAGE);
  await sock(h.socketPath, 'POST', '/sessions', { sessionId: 'ws-3', cwd, title: 'Checkout' });
  await agent(h.socketPath, '/sessions/ws-3/feedback?path=checkout.html', [
    { op: 'addRound', label: 'customers' },
    { op: 'addItem', title: 'Hard to find the filters', lines: [{ key: 'Src', text: '1 · Ana · 03:02 · "Where do I filter?"' }] },
  ]);
  const openLayer = async () => {
    await sock(h.socketPath, 'POST', '/open', { sessionId: 'ws-3', output: { path: 'checkout.html' } });
    await page.getByTestId('feedback-tab').click();
    await page.getByTestId('feedback-item-1').getByTestId('feedback-expand').click();
    await page.getByTestId('feedback-item-1').getByTestId('feedback-workspace-open').click();
    await expect(page.getByTestId('workspace-layer')).toBeVisible();
  };
  await openLayer();
  await page.getByTestId('workspace-note').click();
  await expect(page.getByTestId('mode-write')).toHaveAttribute('aria-selected', 'true');
  const notes = () => ctx.app.evaluate(() => globalThis.__companion.drafts.list().filter((d) => d.sessionId === 'ws-3').map((d) => ({ id: d.id, title: d.title, body: d.body })));
  const [note] = await notes();
  expect(note).toMatchObject({ title: '#1 Hard to find the filters', body: expect.stringContaining('> "Where do I filter?" — Ana') });
  const file = join(cwd, 'checkout.html.feedback.md');
  const line = `    You: ${isoDate(new Date())} · note · Write note "#1 Hard to find the filters"\n`;
  expect(readFileSync(file, 'utf8')).toContain(line);
  await expect(page.locator('.ProseMirror')).toContainText('Feedback item #1 on checkout.html.');

  // A second press opens the same note and logs nothing new.
  await openLayer();
  await expect(page.getByTestId('workspace-rail-entry')).toHaveText([/Write note "#1 Hard to find the filters"/]);
  await page.getByTestId('workspace-note').click();
  await expect(page.getByTestId('mode-write')).toHaveAttribute('aria-selected', 'true');
  expect(await notes()).toHaveLength(1);
  expect(readFileSync(file, 'utf8').split(line)).toHaveLength(2);
});

test('speech in the workspace lands on its pin and saves with it', async () => {
  const speech = join(ROOT, 'e2e/fixtures/speech.wav');
  test.skip(!existsSync(speech), 'speech fixture missing');
  test.setTimeout(120_000);
  const dataDir = tempDataDir();
  const socketPath = join(dataDir, 'companion.sock');
  ctx = await launch(dataDir, { COMPANION_TEST_AUDIO: speech });
  const { app, page } = ctx;
  await showPanel(app, page);
  await expect.poll(() => existsSync(socketPath)).toBe(true);
  const cwd = tempDataDir();
  put(cwd, 'checkout.html', PAGE);
  await sock(socketPath, 'POST', '/sessions', { sessionId: 'ws-4', cwd, title: 'Checkout' });
  await agent(socketPath, '/sessions/ws-4/feedback?path=checkout.html', [{ op: 'addRound', label: 'customers' }, { op: 'addItem', title: 'Pricing is unclear' }]);
  await sock(socketPath, 'POST', '/open', { sessionId: 'ws-4', output: { path: 'checkout.html' } });
  await page.getByTestId('feedback-tab').click();
  await page.getByTestId('feedback-item-1').getByTestId('feedback-expand').click();
  await page.getByTestId('feedback-item-1').getByTestId('feedback-workspace-open').click();
  const layer = page.getByTestId('workspace-layer');
  const canvas = layer.locator('canvas.excalidraw__canvas.interactive');
  await expect(canvas).toBeVisible();

  // Talk turns the comment tool on, and a click pins the words that follow.
  await layer.getByTestId('mic').click();
  await expect(layer.getByTestId('comment-tool')).toHaveAttribute('aria-pressed', 'true');
  await expect(layer.getByTestId('board-comments')).toBeVisible();
  const box = (await canvas.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(layer.getByTestId('board-comment-card')).toHaveCount(1);
  await page.waitForTimeout(5000);
  await layer.getByTestId('mic').click();
  await expect(layer.getByTestId('board-comment-text')).toHaveValue(/pricing table/i, { timeout: 60_000 });

  await layer.getByTestId('workspace-save').click();
  await expect.poll(() => readFileSync(join(cwd, 'checkout.html.feedback.md'), 'utf8')).toMatch(/You: \S+ · note · pin 1 on .+ · .*pricing table/i);
});

test('hiding the panel stops the workspace mic', async () => {
  const speech = join(ROOT, 'e2e/fixtures/speech.wav');
  test.skip(!existsSync(speech), 'speech fixture missing');
  const dataDir = tempDataDir();
  const socketPath = join(dataDir, 'companion.sock');
  ctx = await launch(dataDir, { COMPANION_TEST_AUDIO: speech });
  const { app, page } = ctx;
  await showPanel(app, page);
  await expect.poll(() => existsSync(socketPath)).toBe(true);
  const cwd = tempDataDir();
  put(cwd, 'checkout.html', PAGE);
  await sock(socketPath, 'POST', '/sessions', { sessionId: 'ws-6', cwd, title: 'Checkout' });
  await agent(socketPath, '/sessions/ws-6/feedback?path=checkout.html', [{ op: 'addRound', label: 'customers' }, { op: 'addItem', title: 'Pricing is unclear' }]);
  await sock(socketPath, 'POST', '/open', { sessionId: 'ws-6', output: { path: 'checkout.html' } });
  await page.getByTestId('feedback-tab').click();
  await page.getByTestId('feedback-item-1').getByTestId('feedback-workspace-open').click();
  const layer = page.getByTestId('workspace-layer');
  await expect(layer.locator('canvas.excalidraw__canvas.interactive')).toBeVisible();
  await layer.getByTestId('mic').click();
  await expect(layer.getByTestId('mic')).toHaveAttribute('aria-pressed', 'true');

  // Showing again without a standalone open keeps the Send target, so the layer stays.
  await app.evaluate(() => globalThis.__companion.panel.hide());
  await app.evaluate(() => globalThis.__companion.panel.show());
  await expect(layer).toBeVisible();
  await expect(layer.getByTestId('mic')).toHaveAttribute('aria-pressed', 'false');
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
  await view.getByTestId('feedback-expand').click();

  // Claude's opens overlap the user's, and the round still gets one frame and one quote.
  const cli = () => sock(h.socketPath, 'POST', '/sessions/ws-2/feedback/workspace?path=docs/prd.md&item=1');
  await Promise.all([cli(), view.getByTestId('feedback-workspace-open').click(), cli()]);
  const layer = view.getByTestId('workspace-layer');
  await expect(layer.getByTestId('workspace-board')).toHaveText('fb-prd-1');
  await expect(layer.locator('canvas.excalidraw__canvas.interactive')).toBeVisible();
  const { body } = await sock<ReadResponse>(h.socketPath, 'GET', '/boards/fb-prd-1/elements');
  expect(body.elements.map((e) => e.type).sort()).toEqual(['frame', 'sticky']);
  await page.screenshot({ path: join(RESULTS, 'feedback-workspace-full.png') });
  await layer.getByTestId('workspace-back').click();
  await expect(view.getByTestId('feedback-panel')).toBeVisible();
});
