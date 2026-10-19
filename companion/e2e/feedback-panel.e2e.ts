import { expect, test } from '@playwright/test';
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { FeedbackDocument, OutputRecord } from '../src/protocol';
import { isoDate } from '../src/shared/feedback';
import { deliveriesFor, launch, launchShown, RESULTS, ROOT, showPanel, sock, tempDataDir, type Launched } from './helpers';

let ctx: Launched;
test.afterEach(async () => { await ctx?.app.close(); });

const SPEECH = join(ROOT, 'e2e/fixtures/speech.wav');
const PAGE = '<!doctype html><html><head><title>Checkout</title></head><body><h1>Checkout</h1><div id="filters" style="width:320px;height:60px;background:#c4b5fd">Filters</div><button id="pay">Pay</button></body></html>';

const put = (cwd: string, rel: string, text: string) => {
  mkdirSync(dirname(join(cwd, rel)), { recursive: true });
  writeFileSync(join(cwd, rel), text);
};

async function agent(socketPath: string, route: string, ops: unknown[]) {
  const { body: doc } = await sock<FeedbackDocument>(socketPath, 'GET', route);
  const res = await sock(socketPath, 'POST', route, { version: doc.version, ops });
  expect(res.status).toBe(200);
}

const panelVisible = () => ctx.app.evaluate(() => globalThis.__companion.panel.isVisible());

test('a saved workspace is sendable, and each send names its picture and board', async () => {
  const h = await launchShown();
  ctx = h.ctx;
  const { page } = ctx;
  const cwd = tempDataDir();
  put(cwd, 'checkout.html', PAGE);
  await sock(h.socketPath, 'POST', '/sessions', { sessionId: 'fp-1', cwd, title: 'Checkout' });
  await agent(h.socketPath, '/sessions/fp-1/feedback?path=checkout.html', [
    { op: 'addRound', label: 'customers' },
    { op: 'addItem', title: 'Hard to find the filters', lines: [{ key: 'Where', text: '#filters' }] },
  ]);
  await sock(h.socketPath, 'POST', '/open', { sessionId: 'fp-1', output: { path: 'checkout.html' } });
  await page.getByTestId('feedback-tab').click();
  const card = page.getByTestId('feedback-item-1');
  const sendButton = page.getByTestId('feedback-send');
  await expect(sendButton).toBeDisabled();

  const saveWorkspace = async () => {
    await card.getByTestId('feedback-workspace-open').click();
    const layer = page.getByTestId('workspace-layer');
    await expect(layer.getByTestId('workspace-board')).toHaveText('fb-checkout-1');
    await layer.getByTestId('workspace-save').click();
    await expect(layer.getByTestId('workspace-saved')).toBeVisible();
    await layer.getByTestId('workspace-back').click();
  };
  const picture = (draft: string) => {
    const m = /^ {2}Saved workspace: board fb-checkout-1, picture (\S+\.png)$/m.exec(draft);
    expect(m, draft).not.toBeNull();
    expect(existsSync(join(cwd, m![1]!))).toBe(true);
    expect(draft).toContain('agent-brief read --board');
    return m![1]!;
  };

  // A save alone, with no decision, enables Send.
  await saveWorkspace();
  await expect(sendButton).toHaveText('Send decisions · 1');
  await sendButton.click();
  await expect.poll(async () => (await deliveriesFor(h.socketPath, 'fp-1')).length).toBe(1);
  const first = (await deliveriesFor(h.socketPath, 'fp-1'))[0]!.draft;
  expect(first).toContain('- #1 Hard to find the filters: saved a workspace');
  picture(first);
  const file = join(cwd, 'checkout.html.feedback.md');
  await expect.poll(() => readFileSync(file, 'utf8')).toMatch(/You: \d{4}-\d{2}-\d{2} · sent · through 2\n/);

  // A later save is pending again and goes out on its own send.
  await sock(h.socketPath, 'POST', '/open', { sessionId: 'fp-1', output: { path: 'checkout.html' } });
  await page.getByTestId('feedback-tab').click();
  await expect(sendButton).toBeDisabled();
  await saveWorkspace();
  await expect(sendButton).toHaveText('Send decisions · 1');
  await sendButton.click();
  await expect.poll(async () => (await deliveriesFor(h.socketPath, 'fp-1')).length).toBe(2);
  picture((await deliveriesFor(h.socketPath, 'fp-1'))[1]!.draft);
  await expect.poll(() => readFileSync(file, 'utf8')).toMatch(/sent · through 4\n/);
});

test('a second session finds the project feedback that another session cataloged', async () => {
  const h = await launchShown();
  ctx = h.ctx;
  const { page } = ctx;
  const cwd = tempDataDir();
  put(cwd, 'docs/prd.md', '# PRD\n\n## Pricing\n');
  put(cwd, 'checkout.html', PAGE);
  // The first session declared the PRD, under a ref spelled its own way, and cataloged both files.
  const now = Date.now();
  const prd: OutputRecord = { ref: './docs/prd.md', title: 'PRD', kind: 'markdown', tier: 'declared', status: 'ready', declaredAt: now, firstWriteAt: now, lastWriteAt: now, writes: 1 };
  put(cwd, '.feedback/outputs/fp-a.json', JSON.stringify({ version: 1, sessionId: 'fp-a', outputs: [prd] }));
  await sock(h.socketPath, 'POST', '/sessions', { sessionId: 'fp-a', cwd, title: 'Round one' });
  await agent(h.socketPath, '/sessions/fp-a/feedback?path=docs/prd.md', [{ op: 'addRound', label: 'SME' }, { op: 'addItem', title: 'Pricing section is thin' }]);
  await agent(h.socketPath, '/sessions/fp-a/feedback?path=checkout.html', [{ op: 'addRound', label: 'SME' }, { op: 'addItem', title: 'Pay button wording' }]);
  await sock(h.socketPath, 'POST', '/sessions', { sessionId: 'fp-b', cwd, title: 'Round two' });

  const rows = page.getByTestId('outputs-feedback');
  const openPrd = async () => {
    await page.getByTestId('outputs').locator('li', { has: page.locator('[data-ref$="docs/prd.md"]') }).locator('button.output-feedback').click();
    await expect(page.getByTestId('feedback-view').getByTestId('feedback-item-1')).toContainText('Pricing section is thin');
  };
  const openPage = async () => {
    await rows.locator('[data-ref="checkout.html"]').click();
    await expect(page.getByTestId('feedback-tab')).toHaveText('Feedback · 1 open');
  };

  // The declared PRD keeps its one row. The page it never declared joins the list.
  await sock(h.socketPath, 'POST', '/open', { sessionId: 'fp-a' });
  await page.getByTestId('mode-review').click();
  await expect(page.getByTestId('outputs').locator('[data-ref]')).toHaveCount(2);
  await expect(rows.locator('[data-ref]')).toHaveCount(1);
  await openPrd();
  await openPage();

  // A session with no outputs of its own finds both.
  await sock(h.socketPath, 'POST', '/open', { sessionId: 'fp-b' });
  await page.getByTestId('mode-review').click();
  await expect(rows.locator('[data-ref]')).toHaveCount(2);
  await expect(rows.locator('[data-ref="docs/prd.md"]')).toContainText('Feedback · 1 open');
  await expect(page.getByTestId('outputs').locator('.output-dismiss')).toHaveCount(0);
  await openPrd();
  await page.screenshot({ path: join(RESULTS, 'feedback-project-rows.png') });
  await openPage();
});

test('receipts cover more than one update holds, and a failed receipt keeps the panel up', async () => {
  const h = await launchShown();
  ctx = h.ctx;
  const { page } = ctx;
  const cwd = tempDataDir();
  put(cwd, 'site/notes.txt', 'Notes');
  const today = isoDate(new Date());
  let text = '# Feedback · notes.txt\n\n## Round 1 · SME · 2026-10-12\n';
  for (let n = 1; n <= 201; n++) text += `\n- [ ] #${n} Point ${n}\n    Round: 1\n    Claude: 2026-10-12 · cataloged\n    You: 2026-10-13 · accept\n`;
  put(cwd, 'site/notes.txt.feedback.md', text);
  await sock(h.socketPath, 'POST', '/sessions', { sessionId: 'fp-2', cwd, title: 'Notes' });
  await sock(h.socketPath, 'POST', '/open', { sessionId: 'fp-2' });
  await page.getByTestId('mode-review').click();
  await page.getByTestId('outputs-feedback').locator('button.output-feedback').click();
  const view = page.getByTestId('feedback-view');
  const sendButton = view.getByTestId('feedback-send');
  await expect(sendButton).toHaveText('Send decisions · 201');
  await sendButton.click();
  await expect.poll(async () => (await deliveriesFor(h.socketPath, 'fp-2')).length).toBe(1);
  const file = join(cwd, 'site/notes.txt.feedback.md');
  await expect.poll(() => readFileSync(file, 'utf8').match(new RegExp(`You: ${today} · sent · through 2\\n`, 'g'))?.length).toBe(201);
  await expect.poll(panelVisible).toBe(false);

  // With the folder locked, the send goes out but the receipts cannot land.
  await sock(h.socketPath, 'POST', '/open', { sessionId: 'fp-2' });
  await page.getByTestId('mode-review').click();
  await page.getByTestId('outputs-feedback').locator('button.output-feedback').click();
  await view.getByTestId('feedback-item-1').getByTestId('feedback-reopen').click();
  await expect(sendButton).toHaveText('Send decisions · 1');
  chmodSync(join(cwd, 'site'), 0o555);
  try {
    await sendButton.click();
    await expect.poll(async () => (await deliveriesFor(h.socketPath, 'fp-2')).length).toBe(2);
    await expect(page.getByTestId('send-status')).toHaveText(/^Sent, but the file was not marked for #1\. The next Send repeats them\./);
    expect(await panelVisible()).toBe(true);
    await expect(sendButton).toHaveText('Send decisions · 1');
  } finally {
    chmodSync(join(cwd, 'site'), 0o755);
  }
});

test('page clicks list their items, pins carry them into review.md, and a quote time opens its transcript', async () => {
  const h = await launchShown();
  ctx = h.ctx;
  const { page, app } = ctx;
  const cwd = tempDataDir();
  put(cwd, 'checkout.html', PAGE);
  put(cwd, 'transcripts/cust-1.md', '# Customers\n');
  await sock(h.socketPath, 'POST', '/sessions', { sessionId: 'fp-3', cwd, title: 'Checkout' });
  await agent(h.socketPath, '/sessions/fp-3/feedback?path=checkout.html', [
    { op: 'addRound', label: 'customers', source: 'transcripts/cust-1.md' },
    { op: 'addItem', title: 'Hard to find the filters', lines: [{ key: 'Src', text: '1 · Ana · 03:02 · "Where do I filter?"' }, { key: 'Where', text: '#filters' }] },
    { op: 'addItem', title: 'Pay button wording', lines: [{ key: 'Where', text: '#pay' }] },
  ]);
  await sock(h.socketPath, 'POST', '/open', { sessionId: 'fp-3', output: { path: 'checkout.html' } });
  await page.getByTestId('feedback-tab').click();
  const frame = page.frameLocator('[data-testid="review-frame"]');

  // The quote's time opens the round's transcript.
  await page.getByTestId('feedback-item-1').getByTestId('feedback-source').click();
  await expect.poll(() => app.evaluate(() => [...globalThis.__companion.openedOutputs])).toContain(join(cwd, 'transcripts/cust-1.md'));

  // A click on an element lists the items it holds.
  await expect(async () => {
    await frame.locator('#pay').click();
    await expect(page.getByTestId('feedback-pointed-2')).toBeVisible({ timeout: 500 });
  }).toPass();
  await frame.locator('h1').click();
  await expect(page.getByTestId('feedback-pointed')).toHaveText('No feedback items on this element.');

  // Picking an item ties the next pin to it, wherever it lands. Later pins follow their element.
  await frame.locator('#filters').click();
  await page.getByTestId('feedback-pointed-1').click();
  await expect(page.getByTestId('feedback-item-1')).toHaveClass(/focused/);
  await expect(page.getByTestId('feedback-pointed')).toContainText('Your next pin joins #1.');
  await page.getByTestId('review-comment').click();
  await frame.locator('h1').click();
  await expect(page.getByTestId('review-card')).toHaveCount(1);
  await expect(page.getByTestId('review-card').getByTestId('review-feedback')).toHaveText('#1');
  await page.getByTestId('review-text').fill('Move the filters up here');
  await frame.locator('#pay').click();
  await expect(page.getByTestId('review-card')).toHaveCount(2);
  await expect(page.getByTestId('review-card').nth(1).getByTestId('review-feedback')).toHaveText('#2');
  await frame.locator('h1').click();
  await expect(page.getByTestId('review-card')).toHaveCount(3);
  await expect(page.getByTestId('review-card').nth(2).getByTestId('review-feedback')).toHaveCount(0);
  await page.screenshot({ path: join(RESULTS, 'feedback-pins.png') });

  await page.getByTestId('send').click();
  await expect.poll(async () => (await deliveriesFor(h.socketPath, 'fp-3')).length).toBe(1);
  const [delivery] = await deliveriesFor(h.socketPath, 'fp-3');
  expect(delivery!.draft).toMatch(/feedback-items skill: log a Review line/);
  const md = readFileSync(join(delivery!.dir, 'review.md'), 'utf8');
  expect(md).toContain('Move the filters up here\n');
  expect(md.match(/- Feedback: item #1 in checkout\.html\.feedback\.md\n/g)).toHaveLength(1);
  expect(md.match(/- Feedback: item #2 in checkout\.html\.feedback\.md\n/g)).toHaveLength(1);
  expect(md.match(/- Feedback: no item matches this element in checkout\.html\.feedback\.md\n/g)).toHaveLength(1);
});

test('Refresh reloads the graph after a hand edit', async () => {
  const h = await launchShown();
  ctx = h.ctx;
  const { page } = ctx;
  const cwd = tempDataDir();
  put(cwd, 'checkout.html', PAGE);
  await sock(h.socketPath, 'POST', '/sessions', { sessionId: 'fp-4', cwd, title: 'Checkout' });
  await agent(h.socketPath, '/sessions/fp-4/feedback?path=checkout.html', [{ op: 'addRound', label: 'SME' }, { op: 'addItem', title: 'Title is vague' }]);
  await sock(h.socketPath, 'POST', '/open', { sessionId: 'fp-4', output: { path: 'checkout.html' } });
  await page.getByTestId('feedback-tab').click();
  await page.getByTestId('feedback-graph-toggle').click();
  const graph = page.getByTestId('feedback-graph');
  await expect(graph.locator('[data-id^="item:"]')).toHaveCount(1);
  const file = join(cwd, 'checkout.html.feedback.md');
  writeFileSync(file, `${readFileSync(file, 'utf8')}\n- [ ] #2 Added by hand\n    Round: 1\n`);
  await page.getByTestId('feedback-refresh').click();
  await expect(graph.locator('[data-id^="item:"]')).toHaveCount(2);
});

test('Send decisions stops the item mic and carries the words, and hiding the panel stops it too', async () => {
  test.skip(!existsSync(SPEECH), 'speech fixture missing');
  test.setTimeout(180_000);
  const dataDir = tempDataDir();
  const socketPath = join(dataDir, 'companion.sock');
  ctx = await launch(dataDir, { COMPANION_TEST_AUDIO: SPEECH });
  const { app, page } = ctx;
  await showPanel(app, page);
  await expect.poll(() => existsSync(socketPath)).toBe(true);
  const cwd = tempDataDir();
  put(cwd, 'checkout.html', PAGE);
  await sock(socketPath, 'POST', '/sessions', { sessionId: 'fp-5', cwd, title: 'Checkout' });
  await agent(socketPath, '/sessions/fp-5/feedback?path=checkout.html', [{ op: 'addRound', label: 'SME' }, { op: 'addItem', title: 'Pricing is unclear' }]);
  await sock(socketPath, 'POST', '/open', { sessionId: 'fp-5', output: { path: 'checkout.html' } });
  await page.getByTestId('feedback-tab').click();
  const card = page.getByTestId('feedback-item-1');
  const mic = card.getByTestId('feedback-voice');
  await card.getByTestId('feedback-accept').click();
  await expect(page.getByTestId('feedback-send')).toHaveText('Send decisions · 1');

  // Send while talking: the words land in the file, then in the message.
  await mic.click();
  await expect(mic).toHaveAttribute('aria-pressed', 'true');
  await page.waitForTimeout(5000);
  await page.getByTestId('feedback-send').click();
  await expect.poll(async () => (await deliveriesFor(socketPath, 'fp-5')).length, { timeout: 90_000 }).toBe(1);
  const [delivery] = await deliveriesFor(socketPath, 'fp-5');
  expect(delivery!.draft).toMatch(/- #1 Pricing is unclear: accept; voice · .*pricing table/i);
  const file = join(cwd, 'checkout.html.feedback.md');
  expect(readFileSync(file, 'utf8')).toMatch(/sent · through 3\n/);
  expect(await panelVisible()).toBe(false);

  // Hiding the panel closes the mic, and the words still land.
  await sock(socketPath, 'POST', '/open', { sessionId: 'fp-5', output: { path: 'checkout.html' } });
  await page.getByTestId('feedback-tab').click();
  await expect(mic).toHaveAttribute('aria-pressed', 'false');
  await mic.click();
  await expect(mic).toHaveAttribute('aria-pressed', 'true');
  await page.waitForTimeout(3000);
  await app.evaluate(() => globalThis.__companion.toggle());
  await expect.poll(panelVisible).toBe(false);
  await expect(mic).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(() => readFileSync(file, 'utf8').match(/· voice ·/g)?.length ?? 0, { timeout: 60_000 }).toBe(2);

  // ⌥T stops a recording item mic, and starts no other.
  await showPanel(app, page);
  await sock(socketPath, 'POST', '/open', { sessionId: 'fp-5', output: { path: 'checkout.html' } });
  await page.getByTestId('feedback-tab').click();
  const live = page.locator('[aria-pressed="true"][data-testid="mic"], [aria-pressed="true"][data-testid="feedback-voice"]');
  await mic.click();
  await expect(mic).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Alt+KeyT');
  await expect(mic).toHaveAttribute('aria-pressed', 'false');
  await expect(live).toHaveCount(0);

  // In an item's workspace, ⌥T talks to the workspace's mic.
  await card.getByTestId('feedback-workspace-open').click();
  const layer = page.getByTestId('workspace-layer');
  await expect(layer.locator('canvas.excalidraw__canvas.interactive')).toBeVisible();
  await page.keyboard.press('Alt+KeyT');
  await expect(layer.getByTestId('mic')).toHaveAttribute('aria-pressed', 'true');
  await expect(live).toHaveCount(1);
  await page.keyboard.press('Alt+KeyT');
  await expect(layer.getByTestId('mic')).toHaveAttribute('aria-pressed', 'false');
  await expect(live).toHaveCount(0);
});

test('a feedback file whose output is gone opens from the graph read-only', async () => {
  const h = await launchShown();
  ctx = h.ctx;
  const { page } = ctx;
  const cwd = tempDataDir();
  put(cwd, 'checkout.html', PAGE);
  put(cwd, 'old.html', PAGE);
  await sock(h.socketPath, 'POST', '/sessions', { sessionId: 'fp-6', cwd, title: 'Checkout' });
  await agent(h.socketPath, '/sessions/fp-6/feedback?path=checkout.html', [{ op: 'addRound', label: 'SME' }, { op: 'addItem', title: 'Title is vague' }]);
  await agent(h.socketPath, '/sessions/fp-6/feedback?path=old.html', [
    { op: 'addRound', label: 'SME' },
    { op: 'addItem', title: 'Old page point', lines: [{ key: 'Src', text: '1 · Ana · 01:00 · "Too busy"' }, { key: 'Where', text: '#filters' }] },
    { op: 'append', item: 1, key: 'Claude', text: 'note · looked into it' },
  ]);
  unlinkSync(join(cwd, 'old.html'));
  await sock(h.socketPath, 'POST', '/open', { sessionId: 'fp-6', output: { path: 'checkout.html' } });
  await page.getByTestId('feedback-tab').click();
  await page.getByTestId('feedback-graph-toggle').click();
  await page.getByTestId('feedback-graph').locator('[data-id="item:old.html#1"]').click();

  const view = page.getByTestId('feedback-view');
  await expect(view.getByTestId('feedback-orphan')).toHaveText('old.html is gone, so its feedback is read-only.');
  const card = view.getByTestId('feedback-item-1');
  await expect(card).toContainText('Too busy');
  await card.locator('summary').click();
  await expect(card.getByTestId('feedback-line').last()).toContainText('note · looked into it');
  for (const id of ['feedback-accept', 'feedback-reject', 'feedback-note', 'feedback-voice', 'feedback-workspace-open', 'feedback-show']) await expect(card.getByTestId(id)).toHaveCount(0);
  await expect(view.getByTestId('feedback-send')).toHaveCount(0);
  await expect(view.getByTestId('feedback-open-file')).toHaveCount(0);
  // The orphan is not a row of its own, since its file cannot open.
  await expect(page.getByTestId('outputs-feedback').locator('[data-ref="old.html"]')).toHaveCount(0);
});
