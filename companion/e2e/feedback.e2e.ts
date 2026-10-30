import { expect, test } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { FeedbackDocument, OutputRecord } from '../src/protocol';
import { isoDate } from '../src/shared/feedback';
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

test('lists feedback by round, saves decisions as You lines, and sends them', async () => {
  const h = await launchShown();
  ctx = h.ctx;
  const { page } = ctx;
  const cwd = tempDataDir();
  put(cwd, 'checkout.html', '<!doctype html><html><head><title>Checkout</title></head><body><h1>Checkout</h1><div id="filters">Filters</div><button>Pay</button></body></html>');
  await sock(h.socketPath, 'POST', '/sessions', { sessionId: 'fb-1', cwd, title: 'Checkout' });
  const route = '/sessions/fb-1/feedback?path=checkout.html';
  await agent(h.socketPath, route, [
    { op: 'addRound', label: 'customers', source: 'transcripts/cust-1.md' },
    { op: 'addItem', title: 'Hard to find the filters', lines: [{ key: 'Src', text: '1 · Ana · 03:02 · "Where do I filter?"' }, { key: 'Change', text: 'Move the filter row above the results.' }, { key: 'Where', text: '#filters' }] },
    { op: 'addRound', label: 'SME' },
    { op: 'addItem', title: 'Pay button wording', lines: [{ key: 'Src', text: '2 · Maya · 01:10 · "Pay what?"' }] },
    { op: 'append', item: 1, key: 'Src', text: '2 · Maya · 00:14 · "I couldn\'t find the filters"' },
  ]);
  await sock(h.socketPath, 'POST', '/open', { sessionId: 'fb-1', output: { path: 'checkout.html' } });
  await expect(page.getByTestId('review')).toBeVisible();
  await expect(page.getByTestId('feedback-tab')).toHaveText('Feedback · 2 open');
  await page.getByTestId('feedback-tab').click();

  // Newest round on top, each item under the round it first came up in.
  const panel = page.getByTestId('feedback-panel');
  await expect(panel.locator('.feedback-round h4')).toHaveText([/Round 2 · SME/, /Round 1 · customers/]);
  const first = page.getByTestId('feedback-item-1');
  await expect(page.getByTestId('feedback-round-1')).toContainText('Hard to find the filters');
  await expect(first.getByTestId('feedback-also')).toHaveText('also round 2');
  await expect(first).toContainText('Where do I filter?');
  await expect(first.getByTestId('feedback-change-line')).toHaveText('Move the filter row above the results.');
  await first.getByTestId('feedback-expand').click();
  await expect(first).toContainText('Move the filter row above the results.');
  await first.getByTestId('feedback-show').click();

  const file = join(cwd, 'checkout.html.feedback.md');
  const today = isoDate(new Date());
  await first.getByTestId('feedback-note').fill('keep it sticky on scroll');
  await first.getByTestId('feedback-accept').click();
  await expect(first.getByTestId('feedback-state')).toHaveText('Accepted');
  await expect(first.getByTestId('feedback-note')).toHaveValue('');
  expect(readFileSync(file, 'utf8')).toContain(`    You: ${today} · accept · keep it sticky on scroll\n`);

  // A rejected card keeps only Reopen.
  const second = page.getByTestId('feedback-item-2');
  await second.getByTestId('feedback-expand').click();
  await second.getByTestId('feedback-note').fill('copy belongs to marketing');
  await second.getByTestId('feedback-reject').click();
  await expect(second.getByTestId('feedback-state')).toHaveText('Rejected');
  expect(readFileSync(file, 'utf8')).toContain('- [x] #2 Pay button wording');
  expect(readFileSync(file, 'utf8')).toContain(`You: ${today} · reject · copy belongs to marketing`);
  await expect(second.getByTestId('feedback-reopen')).toBeVisible();
  for (const id of ['feedback-accept', 'feedback-reject', 'feedback-note', 'feedback-voice', 'feedback-workspace-open']) await expect(second.getByTestId(id)).toHaveCount(0);

  // Claude's writes reach the open panel, and the history shows every line.
  await agent(h.socketPath, route, [{ op: 'append', item: 1, key: 'Claude', text: 'note · checking mobile first' }]);
  await first.getByTestId('feedback-expand').click();
  await first.locator('summary').click();
  await expect(first.getByTestId('feedback-line').last()).toHaveText(`Claude${today} · note · checking mobile first`);
  await page.screenshot({ path: join(RESULTS, 'feedback-tab.png') });

  await expect(page.getByTestId('send')).toHaveText('Send decisions · 2');
  await page.getByTestId('send').click();
  await expect.poll(async () => (await deliveriesFor(h.socketPath, 'fb-1')).length).toBe(1);
  const [delivery] = await deliveriesFor(h.socketPath, 'fb-1');
  expect(delivery!.draft).toContain('@checkout.html.feedback.md');
  expect(delivery!.draft).toContain('- #1 Hard to find the filters: accept · keep it sticky on scroll');
  expect(delivery!.draft).toContain('- #2 Pay button wording: reject · copy belongs to marketing');
  await expect.poll(() => readFileSync(file, 'utf8').match(new RegExp(`You: ${today} · sent`, 'g'))?.length).toBe(2);
  await expect(page.getByTestId('send')).toHaveText('Send decisions');
  await expect(page.getByTestId('send')).toBeDisabled();
});

test('opens feedback full width for an output with no page', async () => {
  const h = await launchShown();
  ctx = h.ctx;
  const { page } = ctx;
  const cwd = tempDataDir();
  put(cwd, 'docs/prd.md', '# PRD\n\n## Pricing\n');
  const now = Date.now();
  const prd: OutputRecord = { ref: 'docs/prd.md', title: 'PRD', kind: 'markdown', tier: 'declared', status: 'ready', declaredAt: now, firstWriteAt: now, lastWriteAt: now, writes: 1 };
  put(cwd, '.feedback/outputs/fb-2.json', JSON.stringify({ version: 1, sessionId: 'fb-2', outputs: [prd] }));
  await sock(h.socketPath, 'POST', '/sessions', { sessionId: 'fb-2', cwd, title: 'PRD' });
  await agent(h.socketPath, '/sessions/fb-2/feedback?path=docs/prd.md', [
    { op: 'addRound', label: 'SME' },
    { op: 'addItem', title: 'Pricing section is thin', lines: [{ key: 'Where', text: '## Pricing' }] },
  ]);
  await sock(h.socketPath, 'POST', '/open', { sessionId: 'fb-2' });
  await page.getByTestId('mode-review').click();
  await expect(page.getByTestId('output-feedback-0')).toHaveText('Feedback · 1 open');
  await page.getByTestId('output-feedback-0').click();
  const view = page.getByTestId('feedback-view');
  await expect(view).toContainText('docs/prd.md');
  await view.getByTestId('feedback-expand').click();
  await expect(view.getByTestId('feedback-item-1')).toContainText('Where · ## Pricing');
  await expect(view.getByTestId('feedback-show')).toHaveCount(0);
  await view.getByTestId('feedback-accept').click();
  await expect(view.getByTestId('feedback-state')).toHaveText('Accepted');
  expect(readFileSync(join(cwd, 'docs/prd.md.feedback.md'), 'utf8')).toMatch(/You: \d{4}-\d{2}-\d{2} · accept\n/);
  await expect(page.getByTestId('output-feedback-0')).toHaveText('Feedback');
  await expect(view.getByTestId('feedback-open-file')).toBeVisible();
  await page.screenshot({ path: join(RESULTS, 'feedback-full.png') });

  // The full-width view draws the graph in place of the list.
  await view.getByTestId('feedback-graph-toggle').click();
  await expect(view.getByTestId('feedback-graph')).toBeVisible();
  await expect(page.getByTestId('feedback-graph-layer')).toHaveCount(0);
  await expect(view.getByTestId('feedback-item-1')).toHaveCount(0);
  await page.screenshot({ path: join(RESULTS, 'feedback-graph-inline.png') });
});

test('/open on the Feedback tab opens a Markdown output full width, and without the tab opens Write', async () => {
  const h = await launchShown();
  ctx = h.ctx;
  const { page } = ctx;
  const cwd = tempDataDir();
  put(cwd, 'docs/prd.md', '# PRD\n\n## Pricing\n');
  await sock(h.socketPath, 'POST', '/sessions', { sessionId: 'fb-3', cwd, title: 'PRD' });
  await agent(h.socketPath, '/sessions/fb-3/feedback?path=docs/prd.md', [{ op: 'addRound', label: 'SME' }, { op: 'addItem', title: 'Pricing section is thin' }]);
  const opened = await sock<{ opened?: string }>(h.socketPath, 'POST', '/open', { sessionId: 'fb-3', output: { path: 'docs/prd.md', tab: 'feedback' } });
  expect(opened).toMatchObject({ status: 200, body: { opened: 'review' } });
  await expect(page.getByTestId('mode-review')).toHaveAttribute('aria-selected', 'true');
  const view = page.getByTestId('feedback-view');
  await expect(view).toContainText('docs/prd.md');
  await expect(view.getByTestId('feedback-item-1')).toContainText('Pricing section is thin');
  await page.screenshot({ path: join(RESULTS, 'feedback-open-tab.png') });

  await sock(h.socketPath, 'POST', '/open', { sessionId: 'fb-3', output: { path: 'docs/prd.md' } });
  await expect(page.getByTestId('mode-write')).toHaveAttribute('aria-selected', 'true');
});
