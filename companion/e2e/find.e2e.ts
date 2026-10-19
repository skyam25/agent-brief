import { expect, test, type Page } from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { OutputRecord } from '../src/protocol';
import { backend, FLOW, launch, type Launched, projectDir, RESULTS, showPanel, sock, tempDataDir } from './helpers';

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

/** Clicks Edit › Find, as the menu bar does. */
function menuFind(): Promise<void> {
  return ctx.app.evaluate(({ Menu }) => {
    const edit = Menu.getApplicationMenu()?.items.find((i) => i.label === 'Edit');
    edit?.submenu?.items.find((i) => i.label === 'Find…')?.click();
  });
}

const count = (page: Page) => page.getByTestId('find-count');

const T = Date.now();
const PAGE: OutputRecord = {
  ref: 'site/index.html',
  title: 'Plans',
  kind: 'html',
  tier: 'declared',
  status: 'ready',
  origin: 'created',
  declaredAt: T,
  firstWriteAt: T,
  lastWriteAt: T,
  writes: 1,
};
const filler = Array.from({ length: 60 }, (_, i) => `<p>Filler paragraph ${i + 1}.</p>`).join('\n');
const HTML = `<!doctype html>
<html>
<head><title>Plans</title></head>
<body>
  <h1>Pricing plans</h1>
  <p>Every <b>plan</b> includes
     daily exports.</p>
  ${filler}
  <p id="last">The team plan adds SSO.</p>
  <p style="display: none">A hidden plan never counts.</p>
</body>
</html>
`;

function put(cwd: string, path: string, text: string): void {
  mkdirSync(dirname(join(cwd, path)), { recursive: true });
  writeFileSync(join(cwd, path), text);
}

test('⌘F finds on a review page without changing it, from the pane or the page', async () => {
  const { app, page } = ctx;
  const cwd = mkdtempSync(join(tmpdir(), 'project-'));
  put(cwd, 'site/index.html', HTML);
  put(cwd, '.feedback/outputs/s1.json', JSON.stringify({ version: 1, sessionId: 's1', outputs: [PAGE] }));
  await sock(socketPath, 'POST', '/sessions', { sessionId: 's1', cwd, title: 'Plans' });
  await sock(socketPath, 'POST', '/open', { sessionId: 's1' });
  await showPanel(app, page);
  await page.getByTestId('mode-review').click();
  const frame = page.frameLocator('[data-testid="review-frame"]');
  await expect(frame.locator('h1')).toHaveText('Pricing plans');
  const before = await frame.locator('body').evaluate((b) => b.innerHTML);

  await page.getByTestId('review').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Meta+f');
  const input = page.getByTestId('find-input');
  await expect(input).toBeFocused();

  // Matches cross inline marks and collapsed white space, and skip hidden text.
  await input.fill('plan includes daily');
  await expect(count(page)).toHaveText('1 of 1');
  await input.fill('plan');
  await expect(count(page)).toHaveText('1 of 3');
  await expect.poll(() => frame.locator('body').evaluate(() => CSS.highlights.get('agent-brief-find')?.size)).toBe(3);

  // Stepping back wraps to the last match and scrolls it into view.
  await input.press('Shift+Enter');
  await expect(count(page)).toHaveText('3 of 3');
  await expect(frame.locator('#last')).toBeInViewport();
  await page.screenshot({ path: join(RESULTS, 'find-on-page.png') });

  // With focus in the page, ⌘G steps and ⌘F comes back to the bar. Comment mode is off, so the click pins nothing.
  await page.getByTestId('review-comment').click();
  await frame.locator('#last').click();
  await page.keyboard.press('Meta+g');
  await expect(count(page)).toHaveText('1 of 3');
  await page.keyboard.press('Meta+f');
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('plan');

  await input.press('Escape');
  await expect(page.getByTestId('find-bar')).toHaveCount(0);
  await expect.poll(() => frame.locator('body').evaluate(() => CSS.highlights.has('agent-brief-find'))).toBe(false);
  expect(await frame.locator('body').evaluate((b) => b.innerHTML)).toBe(before);

  // Edit › Find opens it too.
  await menuFind();
  await expect(input).toBeFocused();
});

test('Search notes lists matches filed under other sessions and opens one on its tab', async () => {
  const { app, page } = ctx;
  await sock(socketPath, 'POST', '/sessions', { sessionId: 's1', cwd: projectDir('login'), title: 'Login work' });
  await sock(socketPath, 'POST', '/open', { sessionId: 's1', mode: 'write' });
  await showPanel(app, page);
  await page.evaluate(() => {
    window.__drafts.create('# Plan\n\nThe rollout needs SSO first.', undefined, 's1');
    window.__drafts.create('Lunch order', undefined, 's1');
  });
  await page.getByTestId('notes-tab').click();
  await expect(page.getByTestId('notes-tab')).toHaveAttribute('aria-current', 'true');
  await page.getByTestId('mode-write').click();

  await page.getByTestId('draft-search').fill('rollout');
  const elsewhere = page.getByTestId('draft-elsewhere');
  await expect(elsewhere.getByTestId('draft-row')).toHaveCount(1);
  await expect(elsewhere.getByTestId('draft-row')).toContainText('Login work');

  await elsewhere.getByTestId('draft-row').click();
  await expect(page.locator('[data-testid="brief-tab"][data-session="s1"]')).toHaveAttribute('aria-current', 'true');
  await expect(page.getByTestId('mode-write')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('draft-body')).toContainText('The rollout needs SSO first.');
  await expect(page.getByTestId('find-input')).toHaveValue('rollout');
  await expect(count(page)).toHaveText('1 of 1');

  // On its own tab, the note lists with the others, not under other sessions.
  await expect(page.getByTestId('draft-elsewhere')).toHaveCount(0);
});

test('Edit › Find opens board search on the board and find in a note', async () => {
  const { app, page } = ctx;
  await showPanel(app, page);
  await backend(app, 'draw', 'current', { elements: FLOW });
  await menuFind();
  await expect(page.locator('.layer-ui__search input')).toBeVisible();

  // Opening it twice, as the menu and the page's own ⌘F may, leaves it open.
  await menuFind();
  await expect(page.locator('.layer-ui__search input')).toBeVisible();

  // A second ⌘F keeps the search open and selects the query, as in notes and pages.
  const search = page.locator('.layer-ui__search input');
  await search.fill('SSO');
  for (let i = 0; i < 2; i++) {
    await page.keyboard.press('Meta+f');
    await expect(search).toBeFocused();
    expect(await search.evaluate((input: HTMLInputElement) => input.value.slice(input.selectionStart!, input.selectionEnd!))).toBe('SSO');
  }

  await page.getByTestId('mode-write').click();
  await page.evaluate(() => window.__drafts.create('Remember SSO.'));
  await expect(page.getByTestId('draft-body')).toContainText('Remember SSO.');
  await menuFind();
  await expect(page.getByTestId('find-input')).toBeFocused();
});
