import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { interactiveCanvas, launch, openNotes, penStroke, sceneElements, showPanel, tempDataDir } from './helpers';

test('C1.1 the hotkey toggle shows and hides the panel; test runs stay off screen and unfocused', async () => {
  const { app } = await launch(tempDataDir());
  const c = (fn: string) => app.evaluate((_e, fn) => (globalThis as any).__companion.panel[fn](), fn);

  // Tests never take the user's shortcut; they call what the shortcut calls.
  const shortcut = await app.evaluate(({ globalShortcut }) => {
    const c = (globalThis as any).__companion;
    return {
      real: globalShortcut.isRegistered(c.hotkey.current),
      fake: [...c.registrar.registered.keys()],
    };
  });
  expect(shortcut).toEqual({ real: false, fake: ['Control+Alt+S'] });
  expect(await c('isVisible')).toBe(false);

  // The fake registrar holds the same action the real shortcut would run.
  await app.evaluate(() => (globalThis as any).__companion.registrar.registered.get('Control+Alt+S')());
  expect(await c('isVisible')).toBe(true);

  const placed = await app.evaluate(({ app, screen, BrowserWindow }) => {
    const win = (globalThis as any).__companion.panel.win;
    const b = win.getBounds();
    const overlaps = screen
      .getAllDisplays()
      .some((d) => b.x < d.bounds.x + d.bounds.width && d.bounds.x < b.x + b.width && b.y < d.bounds.y + d.bounds.height && d.bounds.y < b.y + b.height);
    return {
      overlaps,
      focused: win.isFocused() || BrowserWindow.getFocusedWindow() !== null,
      onTop: win.isAlwaysOnTop(),
      dock: app.dock?.isVisible() ?? false,
    };
  });
  expect(placed).toEqual({ overlaps: false, focused: false, onTop: false, dock: false });

  await app.evaluate(() => (globalThis as any).__companion.toggle());
  expect(await c('isVisible')).toBe(false);

  // Closing the window hides it; the app stays up.
  await app.evaluate(() => (globalThis as any).__companion.toggle());
  await app.evaluate(() => (globalThis as any).__companion.panel.win.close());
  expect(await c('isVisible')).toBe(false);
  expect(await app.evaluate(() => typeof (globalThis as any).__companion.toggle)).toBe('function');
  await app.close();
});

test('C1.4 boards, notes, panel size and the current board survive a restart', async () => {
  const dataDir = tempDataDir();
  let { app, page } = await launch(dataDir);
  await showPanel(app, page);
  await openNotes(page);
  const cdp = await page.context().newCDPSession(page);
  const box = (await interactiveCanvas(page).boundingBox())!;
  await penStroke(cdp, { x: box.x + 320, y: box.y + 200 }, { x: box.x + 600, y: box.y + 260 }, 0.6);
  await page.getByTestId('notes').fill('first board notes');

  // A second board through the picker, with its own stroke and notes.
  await page.getByTestId('board-new').click();
  await page.getByTestId('board-name').fill('Sprint ideas');
  await page.getByTestId('board-name').press('Enter');
  await expect(page.getByTestId('board-picker')).toHaveValue('Sprint ideas');
  await penStroke(cdp, { x: box.x + 300, y: box.y + 300 }, { x: box.x + 400, y: box.y + 400 }, 0.6);
  await page.getByTestId('notes').fill('second board notes');
  await app.evaluate(() => (globalThis as any).__companion.panel.win.setSize(900, 640));

  const before = (await sceneElements(page)).filter((e) => !e.isDeleted).map((e) => e.id);
  expect(before).toHaveLength(1);
  await page.waitForTimeout(400);
  await app.close();

  expect(JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8'))).toMatchObject({
    currentBoard: 'Sprint ideas',
    width: 900,
    height: 640,
  });

  ({ app, page } = await launch(dataDir));
  await expect(page.getByTestId('board-picker')).toHaveValue('Sprint ideas');
  await openNotes(page);
  expect((await sceneElements(page)).filter((e) => !e.isDeleted).map((e) => e.id)).toEqual(before);
  await expect(page.getByTestId('notes')).toHaveValue('second board notes');
  const size = await app.evaluate(() => (globalThis as any).__companion.panel.win.getSize());
  expect(size).toEqual([900, 640]);

  await page.getByTestId('board-picker').selectOption('scratch');
  await expect(page.getByTestId('notes')).toHaveValue('first board notes');
  const scratch = (await sceneElements(page)).filter((e) => !e.isDeleted);
  expect(scratch).toHaveLength(1);
  expect(scratch[0].type).toBe('freedraw');
  expect(scratch[0].customData?.createdAt).toBeGreaterThan(0);
  await app.close();
});

test('edits made just before quitting survive, without waiting for the 500 ms save', async () => {
  const dataDir = tempDataDir();
  let { app, page } = await launch(dataDir);
  await showPanel(app, page);
  await openNotes(page);
  const cdp = await page.context().newCDPSession(page);
  const box = (await interactiveCanvas(page).boundingBox())!;
  await penStroke(cdp, { x: box.x + 320, y: box.y + 200 }, { x: box.x + 500, y: box.y + 260 }, 0.6);
  await page.getByTestId('notes').fill('typed at the last moment');
  const id = (await sceneElements(page)).find((e) => e.type === 'freedraw')!.id;
  await app.close();

  ({ app, page } = await launch(dataDir));
  expect((await sceneElements(page)).map((e) => e.id)).toEqual([id]);
  await openNotes(page);
  await expect(page.getByTestId('notes')).toHaveValue('typed at the last moment');
  await app.close();
});

test('renaming a board onto a taken name is refused and says why', async () => {
  const { app, page } = await launch(tempDataDir());
  await showPanel(app, page);
  await page.getByTestId('board-new').click();
  await page.getByTestId('board-name').fill('second');
  await page.getByTestId('board-name').press('Enter');
  await expect(page.getByTestId('board-picker')).toHaveValue('second');

  await page.getByTestId('board-rename').click();
  await page.getByTestId('board-name').fill('scratch');
  await page.getByTestId('board-name').press('Enter');
  await expect(page.getByTestId('send-status')).toHaveText('Could not rename the board: a board named "scratch" exists');
  await expect(page.getByTestId('board-picker')).toHaveValue('second');
  const names = await app.evaluate(() => (globalThis as any).__companion.store.list().map((b: any) => b.name));
  expect(names).toEqual(['scratch', 'second']);

  await page.getByTestId('board-rename').click();
  await page.getByTestId('board-name').fill('../escape');
  await page.getByTestId('board-name').press('Enter');
  await expect(page.getByTestId('send-status')).toHaveText(/Could not rename the board: board name may use letters/);
  await app.close();
});
