import { expect, test } from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { OutputRecord } from '../src/protocol';
import { deliveriesFor, launch, type Launched, RESULTS, ROOT, showPanel, sock, tempDataDir } from './helpers';

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

const PAGE: OutputRecord = {
  ref: 'site/index.html',
  title: 'Landing page',
  kind: 'html',
  tier: 'declared',
  status: 'ready',
  origin: 'created',
  declaredAt: T,
  firstWriteAt: T,
  lastWriteAt: T,
  writes: 1,
};

const HTML = `<!doctype html>
<html>
<head><title>Acme</title><link rel="stylesheet" href="style.css"></head>
<body>
  <h1>Acme analytics</h1>
  <section id="pricing">
    <h2>Pricing plans</h2>
    <p class="lede">Every plan includes unlimited dashboards and daily exports.</p>
    <a href="https://example.com/docs">Read the docs</a>
  </section>
</body>
</html>
`;

function put(cwd: string, path: string, text: string): void {
  mkdirSync(dirname(join(cwd, path)), { recursive: true });
  writeFileSync(join(cwd, path), text);
}

test('an HTML output opens live in the review pane, takes pinned comments, and sends them as review.md', async () => {
  const { app, page } = ctx;
  const cwd = mkdtempSync(join(tmpdir(), 'project-'));
  put(cwd, 'site/index.html', HTML);
  put(cwd, 'site/style.css', 'body { font-family: Georgia; margin: 40px; } h2 { color: rgb(200, 0, 0); }');
  put(cwd, '.env', 'SECRET=1');
  put(cwd, '.feedback/outputs/s1.json', JSON.stringify({ version: 1, sessionId: 's1', outputs: [PAGE] }));
  await sock(socketPath, 'POST', '/sessions', { sessionId: 's1', cwd, title: 'Landing' });
  await sock(socketPath, 'POST', '/open', { sessionId: 's1' });
  await showPanel(app, page);
  await page.getByTestId('mode-write').click();
  await page.getByTestId('output-row-0').click();

  // The page loads live, with its stylesheet, and comment mode starts on.
  const review = page.getByTestId('review');
  await expect(review).toBeVisible();
  const frame = page.frameLocator('[data-testid="review-frame"]');
  await expect(frame.locator('h1')).toHaveText('Acme analytics');
  await expect(frame.locator('h2')).toHaveCSS('color', 'rgb(200, 0, 0)');
  await expect(page.getByTestId('review-comment')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('review-hint')).toBeVisible();
  await expect(page.getByTestId('review-empty')).toBeVisible();

  // Dot files stay out of reach of the page.
  const secret = await frame.locator('body').evaluate(async () => (await fetch('/.env')).status);
  expect(secret).toBe(404);

  // A click pins the element under it, and the new comment takes the cursor.
  await frame.locator('h2').click();
  const cards = page.getByTestId('review-card');
  await expect(cards).toHaveCount(1);
  await expect(cards.nth(0)).toContainText('h2 “Pricing plans”');
  await expect(cards.nth(0).getByTestId('review-text')).toBeFocused();
  await page.keyboard.type('Make this heading bigger.');

  // Dragging across text quotes it.
  const lede = frame.locator('p.lede');
  const box = (await lede.boundingBox())!;
  await page.mouse.move(box.x + 4, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(1).locator('.review-anchor')).toHaveText('p');
  await page.keyboard.type('Say which plans.');

  // A selection shows as a quote on its card.
  await expect(cards.nth(1).getByTestId('review-quote')).toHaveText(/^Every plan/);
  await page.screenshot({ path: join(RESULTS, 'review-pane.png') });

  // Escape leaves comment mode and keeps the panel up. Then links leave for the browser.
  await page.getByTestId('review-comment').click();
  await expect(page.getByTestId('review-comment')).toHaveAttribute('aria-pressed', 'false');
  await frame.locator('a').click();
  const opened = () => app.evaluate(() => [...(globalThis as any).__companion.openedOutputs]);
  await expect.poll(opened).toContain('https://example.com/docs');
  await expect(frame.locator('h1')).toHaveText('Acme analytics');

  // C turns comment mode back on from the page itself.
  await frame.locator('h1').click();
  await page.keyboard.press('c');
  await expect(page.getByTestId('review-comment')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('review-comment')).toHaveAttribute('aria-pressed', 'false');
  expect(await app.evaluate(() => (globalThis as any).__companion.panel.isVisible())).toBe(true);

  await page.getByTestId('review-overall').fill('Tighter spacing overall.');

  // Open in the browser hands the file to its default app.
  await page.getByTestId('review-external').click();
  await expect.poll(opened).toContain(join(cwd, 'site', 'index.html'));

  // Back shows the review in the list, and opening the output again finds it.
  await page.getByTestId('review-close').click();
  await expect(page.getByTestId('draft-row').filter({ hasText: 'Review of index.html' })).toContainText('2 comments');
  await page.getByTestId('output-row-0').click();
  await expect(page.getByTestId('review-card')).toHaveCount(2);

  // Send writes review.md with each pin, its selector and its picture.
  await page.getByTestId('send').click();
  await expect.poll(async () => (await deliveriesFor(socketPath, 's1')).length).toBe(1);
  const [delivery] = await deliveriesFor(socketPath, 's1');
  const id = delivery!.dir.split('/').at(-1);
  expect(delivery!.draft).toBe(
    `@.feedback/sketches/${id}/review.md\nReview of site/index.html from Agent Brief, 2 comments pinned to the page. Make the changes in site/index.html, then say what changed.`,
  );
  const md = readFileSync(join(delivery!.dir, 'review.md'), 'utf8');
  expect(md).toContain('## Overall\n\nTighter spacing overall.');
  expect(md).toContain('## 1. h2 “Pricing plans”\n\nMake this heading bigger.');
  expect(md).toContain('- Element: `#pricing > h2`');
  expect(md).toContain('- Under heading: “Acme analytics”');
  expect(md).toMatch(/## 2\. p “Every plan[^\n]*\n\nSay which plans\./);
  expect(md).toContain('- Element: `#pricing > p.lede`');
  expect(md).toMatch(/- Selected text: “Every plan/);
  expect(readdirSync(join(delivery!.dir, 'images'))).toHaveLength(2);
  expect(md.match(/- Picture: \.feedback\/sketches\/[^/]+\/images\/\w+\.jpg/g)).toHaveLength(2);
});

test('a page Claude changed marks pins whose element is gone', async () => {
  const { app, page } = ctx;
  const cwd = mkdtempSync(join(tmpdir(), 'project-'));
  put(cwd, 'site/index.html', HTML);
  put(cwd, '.feedback/outputs/s1.json', JSON.stringify({ version: 1, sessionId: 's1', outputs: [PAGE] }));
  await sock(socketPath, 'POST', '/sessions', { sessionId: 's1', cwd, title: 'Landing' });
  await sock(socketPath, 'POST', '/open', { sessionId: 's1' });
  await showPanel(app, page);
  await page.getByTestId('mode-write').click();
  await page.getByTestId('output-row-0').click();
  const frame = page.frameLocator('[data-testid="review-frame"]');
  await frame.locator('a').click();
  await expect(page.getByTestId('review-card')).toHaveCount(1);
  await expect(page.getByTestId('review-missing')).toHaveCount(0);

  put(cwd, 'site/index.html', HTML.replace(/<a [^>]*>[^<]*<\/a>/, ''));
  await page.getByTestId('review-reload').click();
  await expect(frame.locator('h1')).toHaveText('Acme analytics');
  await expect(page.getByTestId('review-missing')).toHaveCount(1);
});

test('speech lands on the pin it was said after', async () => {
  const speech = join(ROOT, 'e2e/fixtures/speech.wav');
  test.skip(!existsSync(speech), 'speech fixture missing');
  test.setTimeout(120_000);
  await ctx.app.close();
  const dataDir = tempDataDir();
  socketPath = join(dataDir, 'companion.sock');
  ctx = await launch(dataDir, { COMPANION_TEST_AUDIO: speech });
  const { app, page } = ctx;
  await expect.poll(() => existsSync(socketPath)).toBe(true);
  const cwd = mkdtempSync(join(tmpdir(), 'project-'));
  put(cwd, 'site/index.html', HTML);
  put(cwd, '.feedback/outputs/s1.json', JSON.stringify({ version: 1, sessionId: 's1', outputs: [PAGE] }));
  await sock(socketPath, 'POST', '/sessions', { sessionId: 's1', cwd, title: 'Landing' });
  await sock(socketPath, 'POST', '/open', { sessionId: 's1' });
  await showPanel(app, page);
  await page.getByTestId('mode-write').click();
  await page.getByTestId('output-row-0').click();
  const frame = page.frameLocator('[data-testid="review-frame"]');
  await frame.locator('h2').click();
  await expect(page.getByTestId('review-card')).toHaveCount(1);

  await page.getByTestId('mic').click();
  await expect(page.getByTestId('mic')).toHaveText('00:00');
  await expect(page.getByTestId('review-voice-state')).toHaveText('Listening');
  await page.waitForTimeout(5000);
  await page.getByTestId('mic').click();
  await expect(page.getByTestId('review-text')).toHaveValue(/pricing table/i, { timeout: 60_000 });
  await expect(page.getByTestId('review-voice-state')).toHaveCount(0);
});
