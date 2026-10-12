import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DeliveriesResponse, SessionInfo, SessionsResponse } from '../src/protocol';
import { briefTab, launch, type Launched, openPanelFor, registerSession, showPanel, sock, tempDataDir, themeShots } from './helpers';

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

test('each session gets its own board, and /sketch brings back the one it left', async () => {
  const { app, page } = ctx;
  await register('s1', 'Alpha');
  await register('s2', 'Beta');

  // The first session takes the empty current board.
  expect((await openFor({ sessionId: 's1' })).board).toBe('scratch');
  await drawBox(app, 'scratch', 0);
  await expect.poll(() => onDisk(app, 'scratch')).toBe(1);

  // The second finds the current board in use and gets a board named after it.
  expect((await openFor({ sessionId: 's2' })).board).toBe('Beta');
  await expect.poll(() => shown(page)).toEqual({ board: 'Beta', count: 0 });

  // Back in the first session, /sketch reopens its board with its strokes.
  expect((await openFor({ sessionId: 's1' })).board).toBe('scratch');
  await expect.poll(() => shown(page)).toEqual({ board: 'scratch', count: 1 });

  const list = await briefs(page);
  expect(list.map((b) => [b.sessionId, b.title, b.board, b.isLive, b.isTarget, b.hasContent])).toEqual([
    ['s1', 'Alpha', 'scratch', true, true, true],
    ['s2', 'Beta', 'Beta', true, false, false],
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
  await expect.poll(() => shown(page)).toEqual({ board: 'Beta', count: 0 });
  expect((await sock<SessionsResponse>(socketPath, 'GET', '/sessions')).body.targetSessionId).toBeUndefined();
  const ended = (await briefs(page)).find((b) => b.sessionId === 's2');
  expect(ended).toMatchObject({ title: 'Beta', isLive: false });

  // Forgetting a brief keeps its board.
  await page.evaluate(() => window.companion.forgetBrief('s2'));
  expect((await briefs(page)).map((b) => b.sessionId)).toEqual(['s1']);
  expect(await app.evaluate(() => globalThis.__companion.store.exists('Beta'))).toBe(true);
});

const SHOTS = process.env.UI_SHOTS;
const tabs = (page: Page) => page.getByTestId('brief-tab');

test('the tab row: one tab per session, a click switches board and Send, close keeps the board', async () => {
  const { app, page } = ctx;
  await expect(page.getByTestId('notes-tab')).toHaveAttribute('aria-current', 'true');
  await expect(tabs(page)).toHaveCount(0);
  await register('s1', 'Alpha');
  await register('s2', 'Beta');
  await openFor({ sessionId: 's1' });
  await drawBox(app, 'scratch', 0);
  await expect.poll(() => onDisk(app, 'scratch')).toBe(1);
  await openFor({ sessionId: 's2' });

  // Newest first; the session that opened last is active and named on Send.
  await expect(tabs(page)).toHaveText([/Beta/, /Alpha/]);
  await expect(briefTab(page, 'Beta')).toHaveAttribute('aria-current', 'true');
  await expect(page.getByTestId('send-menu')).toHaveText('Beta');
  await expect(briefTab(page, 'Alpha').getByTestId('brief-unsent')).toBeVisible();
  await expect(briefTab(page, 'Beta').getByTestId('brief-unsent')).toHaveCount(0);

  await briefTab(page, 'Alpha').getByRole('tab').click();
  await expect.poll(() => shown(page)).toEqual({ board: 'scratch', count: 1 });
  await expect(page.getByTestId('send-menu')).toHaveText('Alpha');
  await expect(briefTab(page, 'Alpha')).toHaveAttribute('aria-current', 'true');

  // Notes is ⌃1, so the sessions start at ⌃2; ⌃Tab cycles through Notes too.
  await page.keyboard.press('Control+3');
  await expect(page.getByTestId('send-menu')).toHaveText('Alpha');
  await page.keyboard.press('Control+2');
  await expect(page.getByTestId('send-menu')).toHaveText('Beta');
  await page.keyboard.press('Control+Tab');
  await expect(page.getByTestId('send-menu')).toHaveText('Alpha');
  await page.keyboard.press('Control+Tab');
  await expect(page.getByTestId('notes-tab')).toHaveAttribute('aria-current', 'true');
  await expect(page.getByTestId('send-menu')).toHaveText('Choose a session');
  await page.keyboard.press('Control+Shift+Tab');
  await expect(page.getByTestId('send-menu')).toHaveText('Alpha');

  await themeShots(ctx, 'tabs', { x: 0, y: 0, width: 1100, height: 140 });

  // Closing a tab forgets it; its board stays.
  await briefTab(page, 'Beta').hover();
  await briefTab(page, 'Beta').getByTestId('brief-close').click();
  await expect(tabs(page)).toHaveText([/Alpha/]);
  expect(await app.evaluate(() => globalThis.__companion.store.exists('Beta'))).toBe(true);
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

  await expect(briefTab(page, 'Alpha').locator('.dot')).not.toHaveClass(/live/);
  await briefTab(page, 'Alpha').getByRole('tab').click();
  await expect.poll(() => shown(page)).toEqual({ board: 'scratch', count: 1 });
  await expect(briefTab(page, 'Alpha')).toHaveAttribute('aria-current', 'true');
  // An ended session cannot take a Send, so Send asks where to go.
  await expect(page.getByTestId('send-menu')).toHaveText('Choose a session');
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

test('tabs that do not fit wait behind +N', async () => {
  const { app, page } = ctx;
  for (const [id, title] of [['s1', 'Alpha'], ['s2', 'Beta'], ['s3', 'Gamma'], ['s4', 'Delta'], ['s5', 'Epsilon']]) {
    await register(id, title);
    await openFor({ sessionId: id });
  }
  await app.evaluate(() => globalThis.__companion.panel.win.setSize(560, 600));
  await expect(page.getByTestId('brief-more')).toBeVisible();
  const visible = await tabs(page).count();
  expect(visible).toBeLessThan(5);
  await expect(page.getByTestId('brief-more')).toHaveText(`+${5 - visible}`);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'tabs-overflow.png'), clip: { x: 0, y: 0, width: 560, height: 140 } });

  await page.getByTestId('brief-more').click();
  await expect(page.getByTestId('brief-list-item')).toHaveCount(5);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'tabs-overflow-open.png'), clip: { x: 0, y: 0, width: 560, height: 480 } });
  await page.getByTestId('brief-list-item').filter({ hasText: 'Alpha' }).click();
  await expect(page.getByTestId('send-menu')).toHaveText('Alpha');
  await expect(briefTab(page, 'Alpha')).toHaveAttribute('aria-current', 'true');
});
