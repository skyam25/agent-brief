import { expect, test, type Page } from '@playwright/test';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DeliveriesResponse } from '../src/protocol';
import { launch, type Launched, RESULTS, sendToSession, showPanel, sock, tempDataDir } from './helpers';

let ctx: Launched;
let socketPath: string;
let dataDir: string;

test.beforeEach(async () => {
  dataDir = tempDataDir();
  socketPath = join(dataDir, 'companion.sock');
  ctx = await launch(dataDir);
  await showPanel(ctx.app, ctx.page);
  await expect.poll(() => existsSync(socketPath)).toBe(true);
  await ctx.page.getByTestId('mode-write').click();
});

test.afterEach(async () => {
  await ctx.app.close();
});

const panelVisible = () => ctx.app.evaluate(() => (globalThis as any).__companion.panel.isVisible());
const selection = (page: Page) =>
  page.getByTestId('draft-body').evaluate((el: HTMLTextAreaElement) => el.value.slice(el.selectionStart, el.selectionEnd));
const templateFiles = () => readdirSync(join(dataDir, 'templates')).sort();

test('typing / inserts a template and Tab walks its slots', async () => {
  const { page } = ctx;
  expect(templateFiles()).toEqual(['bug-report.md', 'feature.md', 'plan-first.md']);
  const body = page.getByTestId('draft-body');
  await body.pressSequentially('Context first.\n/bug');
  await expect(page.getByTestId('slash-menu')).toBeVisible();
  await expect(page.getByTestId('slash-item')).toHaveText([/Bug report/]);
  await page.screenshot({ path: join(RESULTS, 'templates-slash.png') });
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('slash-menu')).toHaveCount(0);
  await expect(body).toHaveValue(/^Context first\.\nSomething is broken: \{\{what you saw\}\}/);
  expect(await selection(page)).toBe('{{what you saw}}');

  await page.keyboard.type('login loops back to the form');
  await page.keyboard.press('Tab');
  expect(await selection(page)).toBe('{{steps}}');
  await page.keyboard.press('Shift+Tab');
  // Back wraps to the last slot, since the first is filled now.
  expect(await selection(page)).toBe('{{what should happen}}');
  await page.screenshot({ path: join(RESULTS, 'templates-slots.png') });

  // Escape closes the menu, keeps the text, and leaves the panel up.
  await body.press('Meta+ArrowDown');
  await body.pressSequentially('\n/pla');
  await expect(page.getByTestId('slash-menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('slash-menu')).toHaveCount(0);
  expect(await panelVisible()).toBe(true);
  await expect(body).toHaveValue(/\n\/pla$/);
});

test('Send points out empty slots once, then sends as is', async () => {
  const { page } = ctx;
  const cwd = mkdtempSync(join(tmpdir(), 'project-'));
  await sock(socketPath, 'POST', '/sessions', { sessionId: 's1', cwd, title: 'Login work' });
  await page.getByTestId('draft-new-menu').click();
  await page.getByTestId('new-menu-item').filter({ hasText: 'Feature' }).click();
  await expect.poll(() => selection(page)).toBe('{{the feature}}');
  await page.keyboard.type('split the panel into two windows');

  await sendToSession(page, 'Login work');
  await expect(page.getByTestId('send-status')).toHaveText('3 empty slots. Send again to send anyway.');
  await expect.poll(() => selection(page)).toBe('{{the problem it solves}}');
  await page.getByTestId('draft-body').evaluate((el: HTMLTextAreaElement) => el.blur());
  await page.getByTestId('send').click();
  await expect.poll(panelVisible).toBe(false);
  const { body } = await sock<DeliveriesResponse>(socketPath, 'GET', '/deliveries?session=s1&wait=0');
  expect(body.deliveries[0].draft).toMatch(/^Build split the panel into two windows\.\n\nWhy: \{\{the problem it solves\}\}/);
});

test('templates are written here and saved from a draft', async () => {
  const { page } = ctx;
  await page.getByTestId('templates-toggle').click();
  await expect(page.getByTestId('template-row')).toHaveText([/Bug report/, /Feature/, /Plan first/]);

  await page.getByTestId('template-new').click();
  await expect(page.getByTestId('template-title')).toBeFocused();
  await page.keyboard.type('Code review');
  await page.getByTestId('template-body').fill('Review {{the branch}} for {{what to look for}}.');
  await page.screenshot({ path: join(RESULTS, 'templates-editor.png') });
  await expect.poll(() => templateFiles()).toContain('new-template.md');
  await expect
    .poll(() => readFileSync(join(dataDir, 'templates', 'new-template.md'), 'utf8'))
    .toBe('---\ntitle: Code review\n---\nReview {{the branch}} for {{what to look for}}.');

  await page.getByTestId('template-use').click();
  await expect(page.getByTestId('draft-body')).toHaveValue('Review {{the branch}} for {{what to look for}}.');
  await expect.poll(() => selection(page)).toBe('{{the branch}}');

  // Any draft can become a template.
  await page.getByTestId('draft-body').fill('Write release notes for {{version}}.');
  await page.getByTestId('draft-more').click();
  await page.getByTestId('save-template').click();
  await page.getByTestId('save-template-name').fill('Release notes');
  await page.getByTestId('save-template-name').press('Enter');
  await expect(page.getByTestId('save-template-done')).toHaveText('Saved “Release notes”');
  expect(templateFiles()).toContain('release-notes.md');
  await expect(page.getByTestId('template-row')).toHaveText([/Bug report/, /Code review/, /Feature/, /Plan first/, /Release notes/]);

  await page.getByTestId('template-row').filter({ hasText: 'Feature' }).click();
  await page.getByTestId('template-delete').click();
  await page.getByTestId('template-delete').click();
  await expect(page.getByTestId('template-row')).toHaveCount(4);
  expect(templateFiles()).not.toContain('feature.md');
});
