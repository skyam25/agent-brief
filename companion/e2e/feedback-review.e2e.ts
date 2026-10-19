import { expect, test } from '@playwright/test';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { FeedbackDocument } from '../src/protocol';
import { launchShown, sock, tempDataDir, type Launched } from './helpers';

let ctx: Launched;
test.afterEach(async () => { await ctx?.app.close(); });

const put = (cwd: string, rel: string, text: string) => {
  mkdirSync(dirname(join(cwd, rel)), { recursive: true });
  writeFileSync(join(cwd, rel), text);
};

const page = (heading: string) =>
  `<!doctype html><html><head><title>Checkout</title></head><body><h1>${heading}</h1><div style="height:3000px">Long</div><p id="foot">Foot</p></body></html>`;

async function agent(socketPath: string, route: string, ops: unknown[]) {
  const { body: doc } = await sock<FeedbackDocument>(socketPath, 'GET', route);
  const res = await sock(socketPath, 'POST', route, { version: doc.version, ops });
  expect(res.status).toBe(200);
}

test('opens on the Feedback tab when items are open, or when /open asks for it', async () => {
  const h = await launchShown();
  ctx = h.ctx;
  const { page: panel } = ctx;
  const cwd = tempDataDir();
  put(cwd, 'checkout.html', page('Checkout'));
  put(cwd, 'plain.html', page('Plain'));
  await sock(h.socketPath, 'POST', '/sessions', { sessionId: 'fr-1', cwd, title: 'Checkout' });
  await agent(h.socketPath, '/sessions/fr-1/feedback?path=checkout.html', [
    { op: 'addRound', label: 'customers' },
    { op: 'addItem', title: 'Hard to find the filters' },
  ]);

  // Open items: Feedback first, with comment mode off.
  await sock(h.socketPath, 'POST', '/open', { sessionId: 'fr-1', output: { path: 'checkout.html' } });
  await expect(panel.getByTestId('feedback-tab')).toHaveAttribute('aria-selected', 'true');
  await expect(panel.getByTestId('feedback-panel')).toBeVisible();
  await expect(panel.getByTestId('review-comment')).toHaveAttribute('aria-pressed', 'false');

  // No feedback: Comments, as before.
  await sock(h.socketPath, 'POST', '/open', { sessionId: 'fr-1', output: { path: 'plain.html' } });
  await expect(panel.getByTestId('review')).toContainText('plain.html');
  await expect(panel.getByTestId('feedback-tab')).toHaveAttribute('aria-selected', 'false');

  // `tab: 'feedback'` shows the tab even with nothing open, on a review already showing.
  const res = await sock(h.socketPath, 'POST', '/open', { sessionId: 'fr-1', output: { path: 'plain.html', tab: 'feedback' } });
  expect(res.status).toBe(200);
  await expect(panel.getByTestId('feedback-tab')).toHaveAttribute('aria-selected', 'true');

  // The server refuses another tab.
  const bad = await sock(h.socketPath, 'POST', '/open', { sessionId: 'fr-1', output: { path: 'plain.html', tab: 'comments' } });
  expect(bad.status).toBe(400);
});

test('reloads the page when the file changes on disk and keeps its scroll, and refreshes feedback on hand edits', async () => {
  const h = await launchShown();
  ctx = h.ctx;
  const { page: panel } = ctx;
  const cwd = tempDataDir();
  put(cwd, 'checkout.html', page('Checkout'));
  await sock(h.socketPath, 'POST', '/sessions', { sessionId: 'fr-2', cwd, title: 'Checkout' });
  await sock(h.socketPath, 'POST', '/open', { sessionId: 'fr-2', output: { path: 'checkout.html' } });
  const frame = panel.frameLocator('[data-testid="review-frame"]');
  await expect(frame.locator('h1')).toHaveText('Checkout');
  await frame.locator('body').evaluate(() => scrollTo(0, 900));
  await expect.poll(() => frame.locator('body').evaluate(() => Math.round(scrollY))).toBe(900);

  writeFileSync(join(cwd, 'checkout.html'), page('Checkout v2'));
  await expect(frame.locator('h1')).toHaveText('Checkout v2');
  await expect.poll(() => frame.locator('body').evaluate(() => Math.round(scrollY))).toBe(900);

  // A hand edit to the feedback file reaches the panel without Refresh.
  const file = join(cwd, 'checkout.html.feedback.md');
  await agent(h.socketPath, '/sessions/fr-2/feedback?path=checkout.html', [{ op: 'addRound', label: 'SME' }, { op: 'addItem', title: 'First' }]);
  await panel.getByTestId('feedback-tab').click();
  await expect(panel.getByTestId('feedback-item-1')).toBeVisible();
  appendFileSync(file, readFileSync(file, 'utf8').endsWith('\n') ? '- [ ] #2 Added by hand\n' : '\n- [ ] #2 Added by hand\n');
  await expect(panel.getByTestId('feedback-item-2')).toContainText('Added by hand');
  await expect(panel.getByTestId('feedback-tab')).toHaveText('Feedback · 2 open');
});

test("the pane's own edits do not reload the page", async () => {
  const h = await launchShown();
  ctx = h.ctx;
  const { page: panel } = ctx;
  const cwd = tempDataDir();
  put(cwd, 'checkout.html', page('Checkout'));
  await sock(h.socketPath, 'POST', '/sessions', { sessionId: 'fr-3', cwd, title: 'Checkout' });
  await sock(h.socketPath, 'POST', '/open', { sessionId: 'fr-3', output: { path: 'checkout.html' } });
  const frame = panel.frameLocator('[data-testid="review-frame"]');
  await expect(frame.locator('h1')).toHaveText('Checkout');
  const src = await panel.getByTestId('review-frame').getAttribute('src');

  await panel.getByTestId('review-edit').click();
  await frame.locator('h1').click();
  await panel.getByTestId('field-color').fill('rgb(200, 0, 0)');
  await panel.getByTestId('field-color').press('Enter');
  await expect.poll(() => readFileSync(join(cwd, 'checkout.html'), 'utf8')).toContain('<h1 style="color: rgb(200, 0, 0)">');
  await panel.waitForTimeout(800);
  expect(await panel.getByTestId('review-frame').getAttribute('src')).toBe(src);
  await expect(panel.getByTestId('inspector-label')).toHaveText(/^h1/);
});
