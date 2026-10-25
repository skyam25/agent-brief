import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DeliveriesResponse, SessionInfo, SessionsResponse } from '../src/protocol';
import { projectSlug } from '../src/main/session-names';
import { boardMenu, boardRow, boardRowMenu, briefTab, launch, type Launched, openPanelFor, projectDir, registerSession, showPanel, showEnded, sock, tempDataDir, themeShots } from './helpers';

let ctx: Launched;
let socketPath: string;
let dataDir: string;

test.beforeEach(async () => {
  dataDir = tempDataDir();
  socketPath = join(dataDir, 'companion.sock');
  ctx = await launch(dataDir);
  await expect.poll(() => existsSync(socketPath)).toBe(true);
});

test.afterEach(async () => {
  await ctx.app.close();
});

const register = (sessionId: string, title: string) => registerSession(socketPath, sessionId, title);
const openFor = (body: Record<string, unknown>) => openPanelFor(socketPath, body);
const drawBox = (app: ElectronApplication, board: string, x: number) =>
  app.evaluate((_e, a) => globalThis.__companion.backend.draw(a.board, { elements: [{ type: 'rectangle', x: a.x, y: 0, width: 80, height: 60 }] }), { board, x });
const onDisk = (app: ElectronApplication, board: string) =>
  app.evaluate((_e, name) => globalThis.__companion.store.list().find((b) => b.name === name)?.elementCount ?? 0, board);
const shown = (page: Page) => page.evaluate(() => ({ board: window.__board.board, count: window.__excalidraw.getSceneElements().length }));
const briefs = (page: Page) => page.evaluate(() => window.companion.listBriefs());
/** The name a session's new board gets today. A second one the same day is `<today> 2`. */
const TODAY = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

test('each session gets its own board, and /sketch brings back the one it left', async () => {
  const { app, page } = ctx;
  await register('s1', 'Alpha');
  await register('s2', 'Beta');

  // The first session takes the empty current board.
  expect((await openFor({ sessionId: 's1' })).board).toBe('scratch');
  await drawBox(app, 'scratch', 0);
  await expect.poll(() => onDisk(app, 'scratch')).toBe(1);

  // The second finds the current board in use and gets a board named by the date.
  expect((await openFor({ sessionId: 's2' })).board).toBe(TODAY);
  await expect.poll(() => shown(page)).toEqual({ board: TODAY, count: 0 });

  // Back in the first session, /sketch reopens its board with its strokes.
  expect((await openFor({ sessionId: 's1' })).board).toBe('scratch');
  await expect.poll(() => shown(page)).toEqual({ board: 'scratch', count: 1 });

  const list = await briefs(page);
  expect(list.map((b) => [b.sessionId, b.title, b.board, b.isLive, b.isTarget, b.hasContent])).toEqual([
    ['s1', 'Alpha', 'scratch', true, true, true],
    ['s2', 'Beta', TODAY, true, false, false],
  ]);
});

test('an explicit board wins and is remembered', async () => {
  await register('s1', 'Alpha');
  expect((await openFor({ sessionId: 's1', board: 'login flow' })).board).toBe('login flow');
  expect((await openFor({ sessionId: 's1' })).board).toBe('login flow');
});

test('an unsent sketch survives hiding, other boards and a relaunch, and /sketch finds it again', async () => {
  let { app, page } = ctx;
  await register('s1', 'Alpha');
  expect((await openFor({ sessionId: 's1' })).board).toBe('scratch');
  await drawBox(app, 'scratch', 0);
  await drawBox(app, 'scratch', 120);
  await expect.poll(() => onDisk(app, 'scratch')).toBe(2);

  // Hidden, then opened from the hotkey, the panel picks no session; another board is no session's.
  await app.evaluate(() => globalThis.__companion.toggle());
  await showPanel(app, page);
  await page.evaluate(() => window.__board.switchTo('elsewhere'));
  await expect.poll(() => shown(page)).toEqual({ board: 'elsewhere', count: 0 });

  await app.close();
  ctx = await launch(dataDir);
  ({ app, page } = ctx);
  await expect.poll(() => existsSync(socketPath)).toBe(true);
  await register('s1', 'Alpha');
  expect((await openFor({ sessionId: 's1' })).board).toBe('scratch');
  await expect.poll(() => shown(page)).toEqual({ board: 'scratch', count: 2 });
});

test('/write reopens the session note until it is sent, then starts a new one', async () => {
  const { app, page } = ctx;
  await register('s1', 'Alpha');
  await openFor({ sessionId: 's1', mode: 'write' });
  await expect(page.getByTestId('draft-body')).toBeFocused();
  await page.keyboard.type('half a plan');
  await expect.poll(() => app.evaluate(() => globalThis.__companion.drafts.list().map((d) => d.body))).toEqual(['half a plan']);

  // Another note in between, then /write again from the session.
  await app.evaluate(() => globalThis.__companion.newNote());
  await expect(page.getByTestId('draft-body')).toHaveText('');
  await openFor({ sessionId: 's1', mode: 'write' });
  await expect(page.getByTestId('draft-body')).toHaveText('half a plan');

  // The session is the target, so Send goes straight to it.
  await page.getByTestId('send').click();
  await expect.poll(async () => (await sock<DeliveriesResponse>(socketPath, 'GET', '/deliveries?session=s1&wait=0')).body.deliveries.length).toBe(1);
  await expect.poll(() => app.evaluate(() => globalThis.__companion.drafts.list().length)).toBe(0);
  await showPanel(app, page);
  await openFor({ sessionId: 's1', mode: 'write' });
  await expect(page.getByTestId('draft-body')).toHaveText('');
});

test('a switch opens the session brief and sets the target; an ended session opens with none', async () => {
  const { app, page } = ctx;
  await register('s1', 'Alpha');
  await register('s2', 'Beta');
  await openFor({ sessionId: 's1' });
  await drawBox(app, 'scratch', 0);
  await expect.poll(() => onDisk(app, 'scratch')).toBe(1);
  await openFor({ sessionId: 's2' });

  await page.evaluate(() => window.companion.switchBrief('s1'));
  await expect.poll(() => shown(page)).toEqual({ board: 'scratch', count: 1 });
  expect((await sock<SessionsResponse>(socketPath, 'GET', '/sessions')).body.targetSessionId).toBe('s1');

  await sock(socketPath, 'DELETE', '/sessions/s2');
  await page.evaluate(() => window.companion.switchBrief('s2'));
  await expect.poll(() => shown(page)).toEqual({ board: TODAY, count: 0 });
  expect((await sock<SessionsResponse>(socketPath, 'GET', '/sessions')).body.targetSessionId).toBeUndefined();
  const ended = (await briefs(page)).find((b) => b.sessionId === 's2');
  expect(ended).toMatchObject({ title: 'Beta', isLive: false });

  // Forgetting a brief keeps its board.
  await page.evaluate(() => window.companion.forgetBrief('s2'));
  expect((await briefs(page)).map((b) => b.sessionId)).toEqual(['s1']);
  expect(await app.evaluate((_e, name) => globalThis.__companion.store.exists(name), TODAY)).toBe(true);
});

const SHOTS = process.env.UI_SHOTS;
const tabs = (page: Page) => page.getByTestId('brief-tab');
const crumb = (page: Page) => page.getByTestId('crumb-session');

test('the sidebar: one tab per session, a click switches board and Send, close keeps the board', async () => {
  const { app, page } = ctx;
  await expect(page.getByTestId('notes-tab')).toHaveAttribute('aria-current', 'true');
  await expect(tabs(page)).toHaveCount(0);
  await register('s1', 'Alpha');
  await register('s2', 'Beta');
  await openFor({ sessionId: 's1' });
  await drawBox(app, 'scratch', 0);
  await expect.poll(() => onDisk(app, 'scratch')).toBe(1);
  await openFor({ sessionId: 's2' });

  // Newest first; the session that opened last is active and named in the breadcrumb.
  await expect(tabs(page)).toHaveText([/Beta/, /Alpha/]);
  await expect(briefTab(page, 'Beta')).toHaveAttribute('aria-current', 'true');
  await expect(crumb(page)).toHaveText('Beta');
  await expect(page.getByTestId('send-menu')).toHaveCount(0);
  await expect(briefTab(page, 'Alpha').getByTestId('brief-unsent')).toBeVisible();
  await expect(briefTab(page, 'Beta').getByTestId('brief-unsent')).toHaveCount(0);

  await briefTab(page, 'Alpha').getByRole('tab').click();
  await expect.poll(() => shown(page)).toEqual({ board: 'scratch', count: 1 });
  await expect(crumb(page)).toHaveText('Alpha');
  await expect(briefTab(page, 'Alpha')).toHaveAttribute('aria-current', 'true');

  // Unfiled is ⌃1, so the sessions start at ⌃2; ⌃Tab cycles through Unfiled too.
  await page.keyboard.press('Control+3');
  await expect(crumb(page)).toHaveText('Alpha');
  await page.keyboard.press('Control+2');
  await expect(crumb(page)).toHaveText('Beta');
  await page.keyboard.press('Control+Tab');
  await expect(crumb(page)).toHaveText('Alpha');
  await page.keyboard.press('Control+Tab');
  await expect(page.getByTestId('notes-tab')).toHaveAttribute('aria-current', 'true');
  await expect(crumb(page)).toHaveText('Unfiled');
  await expect(page.getByTestId('send-menu')).toHaveText('Send to…');
  await page.keyboard.press('Control+Shift+Tab');
  await expect(crumb(page)).toHaveText('Alpha');

  await themeShots(ctx, 'tabs', { x: 0, y: 0, width: 1100, height: 140 });

  // Closing a tab forgets it; its board stays.
  await briefTab(page, 'Beta').hover();
  await briefTab(page, 'Beta').getByTestId('brief-close').click();
  await expect(tabs(page)).toHaveText([/Alpha/]);
  expect(await app.evaluate((_e, name) => globalThis.__companion.store.exists(name), TODAY)).toBe(true);
});

test('an ended session keeps its tab, which still opens its board', async () => {
  const { app, page } = ctx;
  await register('s1', 'Alpha');
  await register('s2', 'Beta');
  await openFor({ sessionId: 's1' });
  await drawBox(app, 'scratch', 0);
  await expect.poll(() => onDisk(app, 'scratch')).toBe(1);
  await openFor({ sessionId: 's2' });
  await sock(socketPath, 'DELETE', '/sessions/s1');

  // Ended sessions fold away until the group opens.
  await expect(briefTab(page, 'Alpha')).toHaveCount(0);
  await showEnded(page);
  await expect(briefTab(page, 'Alpha').locator('.dot')).not.toHaveClass(/live/);
  await briefTab(page, 'Alpha').getByRole('tab').click();
  await expect.poll(() => shown(page)).toEqual({ board: 'scratch', count: 1 });
  await expect(briefTab(page, 'Alpha')).toHaveAttribute('aria-current', 'true');
  // An ended session cannot take a Send, so Send asks where to go.
  await expect(crumb(page)).toHaveText('Alpha');
  await expect(page.getByTestId('send-menu')).toHaveText('Send to…');
});

test('a tab shows the mode the mod reports, and drops it when the session ends', async () => {
  const { page } = ctx;
  await register('s1', 'Alpha');
  await register('s2', 'Beta');
  await openFor({ sessionId: 's1' });
  await openFor({ sessionId: 's2' });
  await expect(page.getByTestId('brief-mode')).toHaveCount(0);

  await sock(socketPath, 'PATCH', '/sessions/s1', { mode: 'prototype', fidelity: 'freeze-patch' });
  await sock(socketPath, 'PATCH', '/sessions/s2', { mode: 'product' });
  await expect(briefTab(page, 'Alpha').getByTestId('brief-mode')).toHaveText('Prototype · Freeze + patch');
  await expect(briefTab(page, 'Beta').getByTestId('brief-mode')).toHaveText('Product');
  await themeShots(ctx, 'tab-modes', { x: 0, y: 0, width: 1100, height: 140 });

  await sock(socketPath, 'PATCH', '/sessions/s2', { mode: 'default' });
  await expect(briefTab(page, 'Beta').getByTestId('brief-mode')).toHaveCount(0);

  // The mode lives with the session. A resumed session starts in default until the mod reports again.
  await sock(socketPath, 'DELETE', '/sessions/s1');
  await expect(briefTab(page, 'Alpha').getByTestId('brief-mode')).toHaveCount(0);
  await register('s1', 'Alpha');
  expect((await sock<SessionInfo>(socketPath, 'GET', '/sessions/s1')).body.mode).toBeUndefined();
});

test('the sidebar lists running sessions, folds ended ones, hides, and opens as a drawer when narrow', async () => {
  const { app, page } = ctx;
  for (const [id, title] of [['s1', 'Alpha'], ['s2', 'Beta'], ['s3', 'Gamma']]) {
    await register(id, title);
    await openFor({ sessionId: id });
  }
  await sock(socketPath, 'DELETE', '/sessions/s1');
  await expect(tabs(page)).toHaveCount(2);
  await expect(page.getByTestId('ended-toggle')).toHaveText('Ended 1');
  await showEnded(page);
  await expect(tabs(page)).toHaveCount(3);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'sidebar.png'), clip: { x: 0, y: 0, width: 600, height: 360 } });

  // The toggle hides the sidebar and remembers it.
  await page.getByTestId('sidebar-toggle').click();
  await expect(page.getByTestId('brief-tabs')).toHaveCount(0);
  await page.getByTestId('sidebar-toggle').click();
  await expect(page.getByTestId('brief-tabs')).toBeVisible();

  // A narrow panel opens it over the work, and a pick closes it.
  await app.evaluate(() => globalThis.__companion.panel.win.setSize(560, 600));
  await expect(page.getByTestId('brief-tabs')).toHaveCount(0);
  await page.getByTestId('sidebar-toggle').click();
  await expect(page.getByTestId('brief-tabs')).toHaveClass(/overlay/);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'sidebar-drawer.png') });
  await briefTab(page, 'Beta').getByRole('tab').click();
  await expect(page.getByTestId('brief-tabs')).toHaveCount(0);
  await expect(crumb(page)).toHaveText('Beta');
});

test("a session's board menu lists its own boards, never another session's", async () => {
  const { app, page } = ctx;
  await register('s1', 'Alpha');
  await register('s2', 'Beta');
  await openFor({ sessionId: 's1' });
  await drawBox(app, 'scratch', 0);
  await expect.poll(() => onDisk(app, 'scratch')).toBe(1);
  await openFor({ sessionId: 's2' });
  await expect(crumb(page)).toHaveText('Beta');

  // The menu lists boards only while the sidebar is hidden.
  await page.getByTestId('sidebar-toggle').click();
  const rows = page.getByTestId('board-item');
  await page.getByTestId('board-picker').click();
  await expect(rows).toHaveText([TODAY]);
  await expect(page.getByTestId('board-attach')).toHaveCount(0);
  await page.keyboard.press('Escape');

  await page.getByTestId('sidebar-toggle').click();
  await briefTab(page, 'Alpha').getByRole('tab').click();
  await page.getByTestId('sidebar-toggle').click();
  await expect(page.getByTestId('board-picker')).toHaveText('scratch');
  await page.getByTestId('board-picker').click();
  await expect(rows).toHaveText(['scratch']);
});

test('attaching an unfiled board adds it to the session, which keeps its other boards', async () => {
  const { app, page } = ctx;
  await register('s1', 'Alpha');
  await openFor({ sessionId: 's1' });
  await app.evaluate(() => globalThis.__companion.store.create('loose'));
  const children = page.getByTestId('brief-children');
  await expect(children.getByTestId('brief-board')).toHaveText(['scratch']);

  // A live session's menu offers the unfiled board under Attach. The sidebar lists the session's own.
  await page.getByTestId('board-picker').click();
  await expect(page.getByTestId('board-item')).toHaveCount(0);
  await page.getByTestId('board-attach').filter({ hasText: 'loose' }).click();
  await expect(page.getByTestId('board-picker')).toHaveText('loose');
  await expect.poll(async () => (await briefs(page)).find((b) => b.sessionId === 's1')?.board).toBe('loose');

  // Both boards now show under the session, and the menu has nothing left to attach.
  await expect(children.getByTestId('brief-board').filter({ hasText: 'loose' })).toHaveAttribute('aria-current', 'true');
  await expect(children.getByTestId('brief-board').filter({ hasText: 'scratch' })).toHaveCount(1);
  await page.getByTestId('board-picker').click();
  await expect(page.getByTestId('board-attach')).toHaveCount(0);
});

test('filing a board under Unfiled moves it out of the session and opens the session\'s other board', async () => {
  const { page } = ctx;
  await register('s1', 'Alpha');
  await openFor({ sessionId: 's1' });
  await boardMenu(page, 'board-new');
  await page.getByTestId('board-name').fill('second');
  await page.getByTestId('board-name').press('Enter');
  await expect(page.getByTestId('board-picker')).toHaveText('second');
  const children = page.getByTestId('brief-children').getByTestId('brief-board');
  await expect(children).toHaveCount(2);

  // The row's File under… lists the sessions and Unfiled, with this session checked.
  await boardRowMenu(page, 'second');
  await page.getByTestId('board-file-under').click();
  const targets = page.getByTestId('board-row-menu').getByTestId('file-under');
  await expect(targets.filter({ hasText: 'Alpha' })).toHaveAttribute('aria-checked', 'true');
  await targets.filter({ hasText: 'Unfiled' }).click();
  await expect(page.getByTestId('board-picker')).toHaveText('scratch');
  await expect(children).toHaveText(['scratch']);

  await page.getByTestId('notes-tab').getByRole('tab').click();
  await expect(page.getByTestId('brief-children').getByTestId('brief-board')).toHaveText(['second']);
});

test('unfiled boards file under a session one at a time or as a selection', async () => {
  const { app, page } = ctx;
  await register('s1', 'Alpha');
  await register('s2', 'Beta');
  await openFor({ sessionId: 's1' });
  await openFor({ sessionId: 's2' });
  for (const name of ['loose', 'stray', 'extra']) await app.evaluate((_e, n) => globalThis.__companion.store.create(n), name);
  await page.getByTestId('notes-tab').getByRole('tab').click();
  const children = page.getByTestId('brief-children').getByTestId('brief-board');
  await expect(children.filter({ hasText: 'loose' })).toHaveCount(1);
  const held = async (id: string) => (await page.evaluate(() => window.companion.listBoards())).filter((b) => b.sessionId === id).map((b) => b.name);

  // One board from its row menu. The session keeps the board it had open.
  const before = (await briefs(page)).find((b) => b.sessionId === 's1')?.board;
  await boardRowMenu(page, 'loose');
  await page.getByTestId('board-file-under').click();
  await page.getByTestId('board-row-menu').getByTestId('file-under').filter({ hasText: 'Alpha' }).click();
  await expect.poll(() => held('s1')).toContain('loose');
  await expect(children.filter({ hasText: 'loose' })).toHaveCount(0);
  expect((await briefs(page)).find((b) => b.sessionId === 's1')?.board).toBe(before);

  // Two boards from the selection bar.
  await boardRow(page, 'stray').getByTestId('brief-board').click({ modifiers: ['Meta'] });
  await boardRow(page, 'extra').getByTestId('brief-board').click({ modifiers: ['Meta'] });
  await page.getByTestId('selection-file').click();
  const menu = page.getByTestId('selection-menu');
  await expect(menu).toContainText('File 2 boards under');
  await expect(menu.getByTestId('file-under').filter({ hasText: 'Unfiled' })).toHaveAttribute('aria-checked', 'true');
  await menu.getByTestId('file-under').filter({ hasText: 'Beta' }).click();
  await expect.poll(async () => (await held('s2')).sort()).toEqual(expect.arrayContaining(['extra', 'stray']));
  await expect(page.getByTestId('board-selection')).toHaveCount(0);

  // A board moves between sessions, out of the one that held it.
  await briefTab(page, 'Alpha').getByRole('tab').click();
  await boardRowMenu(page, 'loose');
  await page.getByTestId('board-file-under').click();
  await page.getByTestId('board-row-menu').getByTestId('file-under').filter({ hasText: 'Beta' }).click();
  await expect.poll(() => held('s2')).toContain('loose');
  expect(await held('s1')).not.toContain('loose');
});

test('the footer names no target on a live session, and offers Send to… on Unfiled', async () => {
  const { page } = ctx;
  await showPanel(ctx.app, page);
  await expect(page.getByTestId('send-menu')).toHaveText('Send to…');

  await register('s1', 'Alpha');
  await openFor({ sessionId: 's1' });
  await expect(crumb(page)).toHaveText('Alpha');
  await expect(page.getByTestId('send-menu')).toHaveCount(0);
  await expect(page.getByTestId('send')).toHaveAttribute('title', 'Send to Alpha');

  await page.getByTestId('notes-tab').getByRole('tab').click();
  await expect(crumb(page)).toHaveText('Unfiled');
  await page.getByTestId('send-menu').click();
  await expect(page.getByTestId('send-chooser')).toContainText('Running');
  await expect(page.getByTestId('send-to-session')).toHaveText([/Alpha/]);
});

test('switching to Unfiled opens an unfiled board, never one a session holds', async () => {
  const { page } = ctx;
  await register('s1', 'Alpha');
  expect((await openFor({ sessionId: 's1' })).board).toBe('scratch');
  await expect(page.getByTestId('board-picker')).toHaveText('scratch');

  // The session holds scratch, so Unfiled starts its own.
  await page.getByTestId('notes-tab').getByRole('tab').click();
  await expect(crumb(page)).toHaveText('Unfiled');
  await expect(page.getByTestId('board-picker')).toHaveText('scratch 2');
  await expect(page.getByTestId('brief-children').getByTestId('brief-board')).toHaveText(['scratch 2']);

  // Back and forth, each side reopens its own board.
  await briefTab(page, 'Alpha').getByRole('tab').click();
  await expect(page.getByTestId('board-picker')).toHaveText('scratch');
  await page.keyboard.press('Control+1');
  await expect(page.getByTestId('board-picker')).toHaveText('scratch 2');
});

test("a session row reads its transcript's name and shows whether Claude is working", async () => {
  const { page } = ctx;
  const cwd = projectDir('app');
  const dir = join(dataDir, 'claude-projects', projectSlug(cwd));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 's1.jsonl'), `${JSON.stringify({ type: 'ai-title', aiTitle: 'Fix the login bug', sessionId: 's1' })}\n`);
  await sock(socketPath, 'POST', '/sessions', { sessionId: 's1', cwd, title: 'app', startedAt: 5 });
  await openFor({ sessionId: 's1' });

  const row = briefTab(page, 'Fix the login bug');
  await expect(row).toContainText('Working');
  await expect(row.getByTestId('session-dot')).toHaveClass(/working/);
  await expect(page.getByTestId('crumb-session')).toContainText('Fix the login bug');

  await sock(socketPath, 'POST', '/sessions', { sessionId: 's1', cwd, title: 'app', startedAt: 5, activeAt: Date.now() });
  await expect(row).toContainText('Idle now');
  await expect(row.getByTestId('session-dot')).not.toHaveClass(/working/);
});

test('the Ended group lists its newest five until Show more', async () => {
  const { page } = ctx;
  for (let i = 1; i <= 7; i++) {
    await register(`s${i}`, `Session ${i}`);
    await openFor({ sessionId: `s${i}` });
  }
  await openFor({ sessionId: 's7' });
  for (let i = 1; i <= 6; i++) await sock(socketPath, 'DELETE', `/sessions/s${i}`);
  await expect(page.getByTestId('ended-toggle')).toHaveText('Ended 6');
  await showEnded(page);
  await expect(page.getByTestId('brief-tab')).toHaveCount(6);
  await page.getByTestId('ended-more').click();
  await expect(page.getByTestId('brief-tab')).toHaveCount(7);
  await expect(page.getByTestId('ended-more')).toHaveText('Show fewer');
});
