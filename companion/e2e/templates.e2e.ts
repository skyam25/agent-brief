import { expect, test } from '@playwright/test';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DeliveriesResponse } from '../src/protocol';
import { draftBody, type Launched, launchShown, RESULTS, selectedText, sendToSession, sock, typeDraft } from './helpers';

let ctx: Launched;
let socketPath: string;
let dataDir: string;

test.beforeEach(async () => {
  ({ ctx, socketPath, dataDir } = await launchShown());
  await ctx.page.getByTestId('mode-write').click();
});

test.afterEach(async () => {
  await ctx.app.close();
});

const panelVisible = () => ctx.app.evaluate(() => globalThis.__companion.panel.isVisible());
const templateFiles = () => readdirSync(join(dataDir, 'templates')).filter((f) => f.endsWith('.md')).sort();
const STARTER_FILES = ['bug-report.md', 'decision.md', 'interview-notes.md', 'launch-plan.md', 'one-pager.md', 'prototype.md', 'status-update.md', 'user-story.md'];

test('typing / inserts a template and Tab walks its slots', async () => {
  const { page } = ctx;
  expect(templateFiles()).toEqual(STARTER_FILES);
  const body = page.getByTestId('draft-body');
  await body.click();
  await page.keyboard.type('Context first.\n/bug');
  await expect(page.getByTestId('slash-menu')).toBeVisible();
  // No block type matches "bug", so the template is the only item.
  await expect(page.getByTestId('slash-item')).toHaveText([/Bug report/]);
  await page.screenshot({ path: join(RESULTS, 'templates-slash.png') });
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('slash-menu')).toHaveCount(0);
  await expect.poll(() => draftBody(page)).toMatch(/^Context first\.\n\nWhat happened: \{\{what you saw\}\}/);
  await expect.poll(() => selectedText(page)).toBe('{{what you saw}}');

  await page.keyboard.type('login loops back to the form');
  await page.keyboard.press('Tab');
  await expect.poll(() => selectedText(page)).toBe('{{what should happen}}');
  await page.keyboard.press('Shift+Tab');
  // Back wraps to the last slot, since the first is filled now.
  await expect.poll(() => selectedText(page)).toBe('{{who hits this, and how often}}');
  await page.screenshot({ path: join(RESULTS, 'templates-slots.png') });

  // Escape closes the menu, keeps the text, and leaves the panel up.
  await page.keyboard.press('Meta+ArrowDown');
  // ProseMirror reads the moved caret a moment later. Enter before then lands at the old spot.
  await page.waitForTimeout(100);
  await page.keyboard.type('\n/pla');
  await expect(page.getByTestId('slash-menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('slash-menu')).toHaveCount(0);
  expect(await panelVisible()).toBe(true);
  await expect.poll(() => draftBody(page)).toMatch(/\n\/pla$/);
});

test('right-clicking a template row uses or deletes it', async () => {
  const { page } = ctx;
  await page.getByTestId('templates-toggle').click();
  const row = (title: string) => page.getByTestId('template-row').filter({ hasText: title });

  await row('Decision').click({ button: 'right' });
  await page.getByTestId('row-menu-use').click();
  await expect.poll(() => selectedText(page)).toBe('{{the question}}');

  await row('Bug report').click({ button: 'right' });
  await page.getByTestId('row-menu-delete').click();
  await page.getByTestId('row-menu-delete').click();
  await expect(row('Bug report')).toHaveCount(0);
  await expect.poll(templateFiles).toEqual(STARTER_FILES.filter((f) => f !== 'bug-report.md'));
});

test('Send points out empty slots once, then sends as is', async () => {
  const { page } = ctx;
  const cwd = mkdtempSync(join(tmpdir(), 'project-'));
  await sock(socketPath, 'POST', '/sessions', { sessionId: 's1', cwd, title: 'Login work' });
  await page.getByTestId('draft-new-menu').click();
  await page.getByTestId('new-menu-item').filter({ hasText: 'Prototype' }).click();
  await expect.poll(() => selectedText(page)).toBe('{{the idea}}');
  await page.keyboard.type('a pricing page');

  await sendToSession(page, 'Login work');
  await expect(page.getByTestId('send-status')).toHaveText('5 empty slots. Send again to send anyway.');
  await expect.poll(() => selectedText(page)).toBe('{{show it to or test it with whom}}');
  await page.getByTestId('draft-body').evaluate((el: HTMLElement) => el.blur());
  await page.getByTestId('send').click();
  await expect.poll(panelVisible).toBe(false);
  const { body } = await sock<DeliveriesResponse>(socketPath, 'GET', '/deliveries?session=s1&wait=0');
  expect(body.deliveries[0].draft).toMatch(/^Prototype a pricing page so I can \{\{show it to or test it with whom\}\}\./);
});

test('templates are written here and saved from a draft', async () => {
  const { page } = ctx;
  await page.getByTestId('templates-toggle').click();
  await expect(page.getByTestId('template-row')).toHaveText([/Bug report/, /Decision/, /Interview notes/, /Launch plan/, /One-pager/, /Prototype/, /Status update/, /User story/]);

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
  await expect(page.getByTestId('draft-body')).toHaveText('Review {{the branch}} for {{what to look for}}.');
  await expect.poll(() => selectedText(page)).toBe('{{the branch}}');

  // Any draft can become a template.
  await typeDraft(page, 'Write release notes for {{version}}.');
  await page.getByTestId('draft-more').click();
  await page.getByTestId('save-template').click();
  await page.getByTestId('save-template-name').fill('Release notes');
  await page.getByTestId('save-template-name').press('Enter');
  await expect(page.getByTestId('save-template-done')).toHaveText('Saved “Release notes”');
  expect(templateFiles()).toContain('release-notes.md');
  await expect(page.getByTestId('template-row')).toHaveText([/Bug report/, /Code review/, /Decision/, /Interview notes/, /Launch plan/, /One-pager/, /Prototype/, /Release notes/, /Status update/, /User story/]);

  await page.getByTestId('template-row').filter({ hasText: 'Launch plan' }).click();
  await page.getByTestId('template-delete').click();
  await page.getByTestId('template-delete').click();
  await expect(page.getByTestId('template-row')).toHaveCount(9);
  expect(templateFiles()).not.toContain('launch-plan.md');
});
