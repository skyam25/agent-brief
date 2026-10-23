import { expect, test } from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { OutputRecord } from '../src/protocol';
import { deliveriesFor, launch, type Launched, RESULTS, showPanel, sock, tempDataDir } from './helpers';

let ctx: Launched;
let socketPath: string;

test.beforeEach(async () => {
  const dataDir = tempDataDir();
  socketPath = join(dataDir, 'companion.sock');
  ctx = await launch(dataDir);
  await expect.poll(() => existsSync(socketPath)).toBe(true);
});

test.afterEach(async () => {
  await ctx.app.close();
});

const T = Date.now();

const PRICING: OutputRecord = {
  ref: 'docs/pricing.md',
  title: 'Pricing strategy',
  kind: 'markdown',
  tier: 'declared',
  status: 'drafting',
  origin: 'created',
  declaredAt: T,
  firstWriteAt: T,
  lastWriteAt: T,
  writes: 1,
};

const PAGE: OutputRecord = {
  ref: 'site/index.html',
  kind: 'html',
  tier: 'detected',
  origin: 'edited',
  firstWriteAt: T - 5000,
  lastWriteAt: T - 5000,
  writes: 2,
};

/** Writes a file under the project, making its folders. */
function put(cwd: string, path: string, text: string): void {
  mkdirSync(dirname(join(cwd, path)), { recursive: true });
  writeFileSync(join(cwd, path), text);
}

const writeOutputs = (cwd: string, outputs: OutputRecord[]) =>
  put(cwd, '.feedback/outputs/s1.json', JSON.stringify({ version: 1, sessionId: 's1', outputs }, null, 2));

test('a refiled output note follows its original file and only sends within its original project', async () => {
  const { page } = ctx;
  const alpha = tempDataDir();
  const beta = tempDataDir();
  put(alpha, 'plan.md', '# Alpha original');
  put(beta, 'plan.md', '# Beta original');
  await sock(socketPath, 'POST', '/sessions', { sessionId: 's1', cwd: alpha, title: 'Alpha' });
  await sock(socketPath, 'POST', '/sessions', { sessionId: 's2', cwd: beta, title: 'Beta' });
  await sock(socketPath, 'POST', '/open', { sessionId: 's2' });
  await sock(socketPath, 'POST', '/open', { sessionId: 's1', output: { path: 'plan.md' } });
  await expect(page.getByTestId('draft-body')).toContainText('Alpha original');
  await page.getByTestId('draft-more').click();
  await page.getByTestId('draft-file-under').click();
  await page.getByTestId('file-under').filter({ hasText: 'Beta' }).click();
  await page.getByTestId('brief-tab').filter({ hasText: 'Beta' }).getByRole('tab').click();
  await page.getByTestId('mode-write').click();
  await expect(page.getByTestId('draft-body')).toContainText('Alpha original');
  put(alpha, 'plan.md', '# Alpha revised');
  await expect(page.getByTestId('draft-body')).toContainText('Alpha revised');
  await page.getByTestId('send').click();
  await expect(page.getByTestId('send-status')).toContainText('another project');
  expect(await deliveriesFor(socketPath, 's2')).toHaveLength(0);

  // A fresh session in the original project can still receive the review.
  await sock(socketPath, 'POST', '/sessions', { sessionId: 's3', cwd: alpha, title: 'Alpha resumed' });
  await sock(socketPath, 'POST', '/open', { sessionId: 's3' });
  await page.getByTestId('brief-tab').filter({ hasText: 'Beta' }).getByRole('tab').click();
  await page.getByTestId('mode-write').click();
  await page.getByTestId('draft-more').click();
  await page.getByTestId('draft-file-under').click();
  await page.getByTestId('file-under').filter({ hasText: 'Alpha resumed' }).click();
  await page.getByTestId('brief-tab').filter({ hasText: 'Alpha resumed' }).getByRole('tab').click();
  await page.getByTestId('mode-write').click();
  await page.getByTestId('send').click();
  await expect.poll(async () => (await deliveriesFor(socketPath, 's3')).length).toBe(1);
});

test('hiding an output with feedback stays hidden until its next declaration', async () => {
  const { page } = ctx;
  const cwd = tempDataDir();
  put(cwd, 'docs/pricing.md', '# Pricing');
  put(cwd, 'docs/pricing.md.feedback.md', '# Feedback · pricing.md\n\n- [ ] #1 Shorten it\n    Claude: 2026-10-22 · cataloged\n');
  writeOutputs(cwd, [PRICING]);
  await sock(socketPath, 'POST', '/sessions', { sessionId: 's1', cwd, title: 'Pricing' });
  await sock(socketPath, 'POST', '/open', { sessionId: 's1' });
  await page.getByTestId('mode-review').click();
  const row = page.locator('[data-ref="docs/pricing.md"]');
  await expect(page.getByTestId('output-feedback-0')).toBeVisible();
  await row.hover();
  await page.getByTestId('output-dismiss-0').click();
  await expect(row).toHaveCount(0);
  await page.getByTestId('mode-write').click();
  await page.getByTestId('mode-review').click();
  await expect(row).toHaveCount(0);
  writeOutputs(cwd, [{ ...PRICING, declaredAt: T + 60_000 }]);
  await expect(row).toBeVisible();
});

test('Review mode lists a session\'s outputs, opens them, and sends an edited copy back', async () => {
  const { app, page } = ctx;
  const cwd = mkdtempSync(join(tmpdir(), 'project-'));
  put(cwd, 'docs/pricing.md', '# Pricing strategy\n\nThree tiers, billed yearly.\n');
  put(cwd, 'site/index.html', '<h1>Pricing</h1>\n');
  await sock(socketPath, 'POST', '/sessions', { sessionId: 's1', cwd, title: 'Pricing' });
  await sock(socketPath, 'POST', '/open', { sessionId: 's1' });
  await showPanel(app, page);
  await page.getByTestId('mode-review').click();
  await expect(page.getByTestId('review-mode')).toBeVisible();
  // A session with no outputs shows no section at all.
  await expect(page.getByTestId('outputs')).toHaveCount(0);

  // The mod writes the file; the list picks it up. Touched rows wait behind their toggle.
  writeOutputs(cwd, [PRICING, PAGE]);
  const declared = page.getByTestId('output-row-0');
  await expect(declared).toContainText('Pricing strategy');
  await expect(declared).toHaveAttribute('data-ref', 'docs/pricing.md');
  await expect(declared).toContainText('docs/pricing.md');
  await expect(declared).toContainText('Markdown');
  await expect(page.getByTestId('output-status-0')).toHaveText('Drafting');
  const toggle = page.getByTestId('outputs-touched-toggle');
  await expect(toggle).toContainText('Touched (1)');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('output-row-1')).toHaveCount(0);
  await toggle.click();
  await expect(page.getByTestId('output-row-1')).toHaveAttribute('data-ref', 'site/index.html');
  await expect(page.getByTestId('output-row-1')).toContainText('HTML');
  await expect(page.getByTestId('output-row-1')).toContainText('edited');

  // A status change in the file reaches the chip.
  writeOutputs(cwd, [{ ...PRICING, status: 'ready' }, PAGE]);
  await expect(page.getByTestId('output-status-0')).toHaveText('Ready');
  await page.screenshot({ path: join(RESULTS, 'outputs-list.png') });

  // A markdown output opens in Write mode as a note that names its source file.
  await declared.click();
  await expect(page.getByTestId('mode-write')).toHaveAttribute('aria-selected', 'true');
  // Write holds your notes alone.
  await expect(page.getByTestId('outputs')).toHaveCount(0);
  await expect(page.getByTestId('draft-body').locator('h1')).toHaveText('Pricing strategy');
  await expect(page.getByTestId('draft-source')).toHaveText(
    'From docs/pricing.md. Send asks Claude to apply your changes to the file.',
  );

  // Send hands Claude the edited copy and asks it to apply the changes to the file.
  await page.getByTestId('send').click();
  await expect.poll(async () => (await deliveriesFor(socketPath, 's1')).length).toBe(1);
  const [delivery] = await deliveriesFor(socketPath, 's1');
  expect(delivery!.draft.startsWith('@.feedback/sketches/')).toBe(true);
  expect(delivery!.draft).toContain('Apply the changes to docs/pricing.md');
  expect(existsSync(join(delivery!.dir, 'draft.md'))).toBe(true);
  await expect.poll(() => app.evaluate(() => globalThis.__companion.panel.isVisible())).toBe(false);

  // An HTML output opens in the review pane, which can still hand it to the browser.
  // A standalone show clears the target. The switch then sets it, and Review needs it.
  await showPanel(app, page);
  const crumb = page.getByTestId('crumb-session');
  await expect(crumb).toHaveText('Unfiled');
  await page.getByTestId('brief-tab').filter({ hasText: 'Pricing' }).getByRole('tab').click();
  await expect(crumb).toHaveText('Pricing');
  await page.getByTestId('mode-review').click();
  const touched = page.getByTestId('outputs-touched-toggle');
  await expect(touched).toBeVisible();
  if ((await touched.getAttribute('aria-expanded')) !== 'true') await touched.click();
  const opened = () => app.evaluate(() => [...globalThis.__companion.openedOutputs]);
  await page.getByTestId('output-row-1').click();
  await expect(page.frameLocator('[data-testid="review-frame"]').locator('h1')).toHaveText('Pricing');
  await page.getByTestId('review-external').click();
  await expect.poll(opened).toContain(join(cwd, 'site', 'index.html'));
  // The page takes this narrow panel. The toggle brings the list back beside it.
  await page.getByTestId('review-list-toggle').click();

  // Hide drops a row until Claude touches it again.
  await page.getByTestId('output-row-0').hover();
  await page.getByTestId('output-dismiss-0').click();
  await expect(page.locator('[data-ref="docs/pricing.md"]')).toHaveCount(0);
  await expect(page.locator('[data-ref="site/index.html"]')).toBeVisible();
  writeOutputs(cwd, [{ ...PRICING, status: 'ready', declaredAt: T + 60_000 }, PAGE]);
  await expect(page.locator('[data-ref="docs/pricing.md"]')).toBeVisible();
});

test('POST /open with an output opens it in the panel for that session', async () => {
  const { page } = ctx;
  const cwd = mkdtempSync(join(tmpdir(), 'project-'));
  put(cwd, 'docs/pricing.md', '# Pricing strategy\n');
  put(cwd, 'site/index.html', '<h1>Pricing</h1>\n');
  await sock(socketPath, 'POST', '/sessions', { sessionId: 's1', cwd, title: 'Pricing' });

  const note = await sock<Record<string, unknown>>(socketPath, 'POST', '/open', { sessionId: 's1', output: { path: 'docs/pricing.md' } });
  expect(note).toMatchObject({ status: 200, body: { opened: 'note', targetSessionId: 's1' } });
  await expect(page.getByTestId('mode-write')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('draft-body').locator('h1')).toHaveText('Pricing strategy');
  expect((await sock<{ panelVisible: boolean }>(socketPath, 'GET', '/health')).body.panelVisible).toBe(true);

  const review = await sock(socketPath, 'POST', '/open', { sessionId: 's1', output: { path: 'site/index.html' } });
  expect(review).toMatchObject({ status: 200, body: { opened: 'review' } });
  await expect(page.frameLocator('[data-testid="review-frame"]').locator('h1')).toHaveText('Pricing');

  const outside = await sock<{ error: string }>(socketPath, 'POST', '/open', { sessionId: 's1', output: { path: '../escape.md' } });
  expect(outside.status).toBe(400);
  expect(outside.body.error).toContain('outside the project');
  expect((await sock(socketPath, 'POST', '/open', { sessionId: 's1' })).body).toMatchObject({ opened: 'board' });
});
