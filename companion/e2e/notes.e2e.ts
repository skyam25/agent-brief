import { expect, test, type Page } from '@playwright/test';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionsResponse } from '../src/protocol';
import { briefTab, draftsOnDisk, launch, type Launched, openPanelFor, projectDir, registerSession, showEnded, showPanel, sock, tempDataDir, themeShots, typeDraft } from './helpers';

let ctx: Launched;
let socketPath: string;
let dataDir: string;

test.beforeEach(async () => {
  dataDir = tempDataDir();
  socketPath = join(dataDir, 'companion.sock');
  ctx = await launch(dataDir);
  await showPanel(ctx.app, ctx.page);
  await expect.poll(() => existsSync(socketPath)).toBe(true);
});

test.afterEach(async () => {
  await ctx.app.close();
});

const register = (sessionId: string, title: string, cwd?: string) => registerSession(socketPath, sessionId, title, cwd);
const openFor = (body: Record<string, unknown>) => openPanelFor(socketPath, body);
const target = async () => (await sock<SessionsResponse>(socketPath, 'GET', '/sessions')).body.targetSessionId;
const filedAs = (body: string) => draftsOnDisk(dataDir).find((d) => d.body === body)?.sessionId ?? null;
const notesTab = (page: Page) => page.getByTestId('notes-tab');
const rows = (page: Page) => page.getByTestId('draft-row');

test('the Notes tab is first and always there, and has no Items', async () => {
  const { page } = ctx;
  await expect(notesTab(page)).toHaveAttribute('aria-current', 'true');
  await expect(page.getByTestId('brief-tab')).toHaveCount(0);
  await expect(page.getByTestId('mode-items')).toHaveCount(0);

  await register('s1', 'Alpha');
  await openFor({ sessionId: 's1' });
  await expect(briefTab(page, 'Alpha')).toHaveAttribute('aria-current', 'true');
  await expect(page.getByTestId('brief-tabs').locator('.tab').first()).toHaveAttribute('data-testid', 'notes-tab');
  await expect(notesTab(page).locator('.dot')).toHaveCount(0);
  await expect(notesTab(page).getByTestId('brief-close')).toHaveCount(0);
  await expect(page.getByTestId('mode-items')).toBeVisible();

  // Notes clears the Send target, and Items falls back to Write.
  await page.getByTestId('mode-items').click();
  await notesTab(page).getByRole('tab').click();
  await expect(notesTab(page)).toHaveAttribute('aria-current', 'true');
  await expect(page.getByTestId('mode-write')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('mode-items')).toHaveCount(0);
  await expect(page.getByTestId('send-menu')).toHaveText('Choose a session');
  await expect.poll(target).toBeUndefined();
});

test('a note stays on the tab it was written on', async () => {
  const { page } = ctx;
  await register('s1', 'Alpha');
  await page.getByTestId('mode-write').click();
  await typeDraft(page, 'loose idea');
  await expect(page.getByTestId('draft-filing')).toHaveText('Unfiled');
  await expect.poll(() => filedAs('loose idea')).toBeNull();

  // /write files its note under the session and opens that session's tab.
  await openFor({ sessionId: 's1', mode: 'write', text: 'hi' });
  await expect(page.getByTestId('draft-body')).toHaveText('hi');
  await expect(briefTab(page, 'Alpha')).toHaveAttribute('aria-current', 'true');
  await expect(page.getByTestId('draft-filing')).toHaveText('Alpha');
  await expect(rows(page)).toHaveText([/hi/]);
  await expect.poll(() => filedAs('hi')).toBe('s1');

  await notesTab(page).getByRole('tab').click();
  await expect(rows(page)).toHaveText([/loose idea/]);
  await expect(page.getByTestId('draft-body')).toHaveText('loose idea');

  await briefTab(page, 'Alpha').getByRole('tab').click();
  await expect(rows(page)).toHaveText([/hi/]);
  await expect(page.getByTestId('draft-body')).toHaveText('hi');

  // A new note on a session tab is filed under it.
  await page.getByTestId('draft-new').click();
  await typeDraft(page, 'second for Alpha');
  await expect.poll(() => filedAs('second for Alpha')).toBe('s1');
});

test('File under moves a note between Notes and a session tab', async () => {
  const { page } = ctx;
  await register('s1', 'Alpha');
  await openFor({ sessionId: 's1' });
  await notesTab(page).getByRole('tab').click();
  await page.getByTestId('mode-write').click();
  await typeDraft(page, 'move me');
  await expect(rows(page)).toHaveText([/move me/]);

  await page.getByTestId('draft-filing').click();
  await expect(page.getByTestId('file-under')).toHaveText(['Alpha', 'Unfiled']);
  await themeShots(ctx, 'filing-menu');
  await page.getByTestId('file-under').filter({ hasText: 'Alpha' }).click();
  await expect(page.getByTestId('send-status')).toHaveText('Moved to Alpha.');
  await expect(rows(page)).toHaveCount(0);
  await expect.poll(() => filedAs('move me')).toBe('s1');

  await briefTab(page, 'Alpha').getByRole('tab').click();
  await page.getByTestId('mode-write').click();
  await expect(rows(page)).toHaveText([/move me/]);
  await expect(rows(page).getByTestId('draft-row-filing')).toHaveText('Alpha');
  await expect(page.getByTestId('draft-body')).toHaveText('move me');

  await page.getByTestId('draft-filing').click();
  await page.getByTestId('file-under').filter({ hasText: 'Unfiled' }).click();
  await expect(page.getByTestId('send-status')).toHaveText('Moved to Notes.');
  await expect(rows(page)).toHaveCount(0);
  await expect.poll(() => filedAs('move me')).toBeNull();

  await notesTab(page).getByRole('tab').click();
  await expect(rows(page)).toHaveText([/move me/]);
});

test('an ended session shows how to resume it, until it comes back', async () => {
  const { app, page } = ctx;
  // Terminal launchers need the folder to exist.
  const cwd = projectDir('alpha');
  mkdirSync(cwd);
  await register('s1', 'Alpha', cwd);
  await openFor({ sessionId: 's1' });
  await expect(page.getByTestId('resume-row')).toHaveCount(0);

  await sock(socketPath, 'DELETE', '/sessions/s1');
  await showEnded(page);
  await briefTab(page, 'Alpha').getByRole('tab').click();
  await expect(briefTab(page, 'Alpha')).toHaveAttribute('aria-current', 'true');
  const row = page.getByTestId('resume-row');
  await expect(row).toContainText('Session ended');
  await expect(page.getByTestId('resume-command')).toHaveText(/claude --resume '?s1'?$/);
  const command = await page.getByTestId('resume-command').getAttribute('title');
  expect(command).toMatch(/^cd .*alpha'? && claude --resume '?s1'?$/);
  await themeShots(ctx, 'resume-row');

  const clipboard = () => app.evaluate(() => globalThis.__companion.clipboard());
  await page.getByTestId('resume-copy').click();
  await expect(page.getByTestId('send-status')).toHaveText('Copied the resume command');
  await expect.poll(clipboard).toBe(command);

  // The menu offers each launcher; copy hands back main's message.
  await page.getByTestId('resume-more').click();
  await expect(page.getByTestId('resume-open-copy')).toHaveText('Copy command');
  await page.getByTestId('resume-open-copy').click();
  await expect(page.getByTestId('send-status')).toHaveText('Copied the resume command');

  // The split button's main half starts a terminal there. Test mode records it instead.
  const launches = () => app.evaluate(() => globalThis.__companion.launches.map((l) => [l.file, ...l.args].join(' ')));
  await page.getByTestId('resume-open-ghostty').click();
  await expect(page.getByTestId('send-status')).toHaveText(/^Resuming the session in Ghostty/);
  await expect.poll(async () => (await launches()).some((l: string) => l.includes('s1'))).toBe(true);

  await register('s1', 'Alpha');
  await expect(row).toHaveCount(0);
});
