import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { boardMenu, boardRow, boardRowMenu, interactiveCanvas, renameBoardRow, RESULTS, launch, openNotes, penStroke, pickPen, pickBoard, sceneElements, showPanel, tempDataDir } from './helpers';

test('C1.1 the hotkey toggle shows and hides the panel; test runs stay off screen and unfocused', async () => {
  const { app } = await launch(tempDataDir());
  const c = (fn: 'isVisible') => app.evaluate((_e, fn) => globalThis.__companion.panel[fn](), fn);

  // Tests never take the user's shortcut; they call what the shortcut calls.
  const shortcut = await app.evaluate(({ globalShortcut }) => {
    const c = globalThis.__companion;
    return {
      real: globalShortcut.isRegistered(c.hotkey.current!),
      fake: [...c.registrar.registered.keys()],
    };
  });
  expect(shortcut).toEqual({ real: false, fake: ['Control+Alt+S', 'Control+Alt+N'] });
  expect(await c('isVisible')).toBe(false);

  // The fake registrar holds the same action the real shortcut would run.
  await app.evaluate(() => globalThis.__companion.registrar.registered.get('Control+Alt+S')!());
  expect(await c('isVisible')).toBe(true);

  const placed = await app.evaluate(({ app, screen, BrowserWindow }) => {
    const win = globalThis.__companion.panel.win;
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

  await app.evaluate(() => globalThis.__companion.toggle());
  expect(await c('isVisible')).toBe(false);

  // Closing the window hides it; the app stays up.
  await app.evaluate(() => globalThis.__companion.toggle());
  await app.evaluate(() => globalThis.__companion.panel.win.close());
  expect(await c('isVisible')).toBe(false);
  expect(await app.evaluate(() => typeof globalThis.__companion.toggle)).toBe('function');
  await app.close();
});

test('C1.4 boards, notes, panel size and the current board survive a restart', async () => {
  const dataDir = tempDataDir();
  let { app, page } = await launch(dataDir);
  await showPanel(app, page);
  await openNotes(page);
  const cdp = await page.context().newCDPSession(page);
  await pickPen(page);
  const box = (await interactiveCanvas(page).boundingBox())!;
  await penStroke(cdp, { x: box.x + 320, y: box.y + 200 }, { x: box.x + 600, y: box.y + 260 }, 0.6);
  await page.getByTestId('notes').fill('first board notes');

  // A second board through the picker, with its own stroke and notes.
  await boardMenu(page, 'board-new');
  await page.getByTestId('board-name').fill('Sprint ideas');
  await page.getByTestId('board-name').press('Enter');
  await expect(page.getByTestId('board-picker')).toHaveText('Sprint ideas');
  await penStroke(cdp, { x: box.x + 300, y: box.y + 300 }, { x: box.x + 400, y: box.y + 400 }, 0.6);
  await page.getByTestId('notes').fill('second board notes');
  await app.evaluate(() => globalThis.__companion.panel.win.setSize(900, 640));

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
  await expect(page.getByTestId('board-picker')).toHaveText('Sprint ideas');
  await openNotes(page);
  expect((await sceneElements(page)).filter((e) => !e.isDeleted).map((e) => e.id)).toEqual(before);
  await expect(page.getByTestId('notes')).toHaveValue('second board notes');
  const size = await app.evaluate(() => globalThis.__companion.panel.win.getSize());
  expect(size).toEqual([900, 640]);

  await pickBoard(page, 'scratch');
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
  await pickPen(page);
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
  await boardMenu(page, 'board-new');
  await page.getByTestId('board-name').fill('second');
  await page.getByTestId('board-name').press('Enter');
  await expect(page.getByTestId('board-picker')).toHaveText('second');

  await renameBoardRow(page, 'second', 'scratch');
  await expect(page.getByTestId('send-status')).toHaveText('Could not rename the board: a board named "scratch" exists');
  await expect(page.getByTestId('board-picker')).toHaveText('second');
  const names = await app.evaluate(() => globalThis.__companion.store.list().map((b) => b.name));
  expect(names).toEqual(['scratch', 'second']);

  await renameBoardRow(page, 'second', '../escape');
  await expect(page.getByTestId('send-status')).toHaveText(/Could not rename the board: board name may use letters/);
  await app.close();
});

test('with the sidebar open, the board menu holds only New, and each row has its own menu', async () => {
  const { app, page } = await launch(tempDataDir());
  await showPanel(app, page);
  const names = () => app.evaluate(() => globalThis.__companion.store.list().map((b) => b.name));
  for (const name of ['second', 'third']) {
    await boardMenu(page, 'board-new');
    await page.getByTestId('board-name').fill(name);
    await page.getByTestId('board-name').press('Enter');
    await expect(page.getByTestId('board-picker')).toHaveText(name);
  }

  // The sidebar lists the boards, so the menu lists none and keeps only New.
  await expect(page.getByTestId('brief-children').getByTestId('brief-board')).toHaveText(['scratch', 'second', 'third']);
  await page.getByTestId('board-picker').click();
  await expect(page.getByTestId('board-item')).toHaveCount(0);
  await expect(page.getByTestId('board-menu').getByRole('menuitem')).toHaveText(['New board']);
  await page.keyboard.press('Escape');

  // A row's ⋯ and its right-click open the same menu.
  await boardRowMenu(page, 'second');
  const menu = page.getByTestId('board-row-menu');
  await expect(menu.getByRole('menuitem')).toHaveText(['Rename', 'Copy reference', 'File under…', 'Delete board']);

  // Copy reference puts a line a new session can act on.
  await page.getByTestId('board-row-copy').click();
  await expect(page.getByTestId('send-status')).toHaveText('Copied. Paste it into any Claude Code session.');
  await expect
    .poll(() => app.evaluate(() => globalThis.__companion.clipboard()))
    .toBe(`Open my Agent Brief board "second" with agent-brief open --board 'second', then read it with agent-brief read --board 'second'.`);
  await boardRowMenu(page, 'second');
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await boardRow(page, 'second').getByTestId('brief-board').click({ button: 'right' });
  await expect(menu).toBeVisible();

  // Rename works on a board that is not open, and the open board stays.
  await page.getByTestId('board-row-rename').click();
  await page.getByTestId('board-row-name').fill('renamed');
  await page.getByTestId('board-row-name').press('Enter');
  await expect.poll(names).toEqual(['renamed', 'scratch', 'third']);
  await expect(page.getByTestId('board-picker')).toHaveText('third');

  // Double-click renames too, and Escape keeps the name.
  await boardRow(page, 'scratch').getByTestId('brief-board').dblclick();
  await page.getByTestId('board-row-name').fill('dropped');
  await page.getByTestId('board-row-name').press('Escape');
  await expect(boardRow(page, 'scratch')).toHaveCount(1);

  // Delete asks first. The second click deletes the open board and opens another.
  await boardRowMenu(page, 'third');
  const del = page.getByTestId('board-row-delete');
  await del.click();
  await expect(del).toHaveText('Click again to delete');
  await del.click();
  await expect.poll(names).toEqual(['renamed', 'scratch']);
  await expect(page.getByTestId('board-picker')).not.toHaveText('third');
  await expect(menu).toHaveCount(0);
  await app.close();
});

test('⌘ and ⇧ select several boards, and the selection bar deletes them after asking', async () => {
  const { app, page } = await launch(tempDataDir());
  await showPanel(app, page);
  const names = () => app.evaluate(() => globalThis.__companion.store.list().map((b) => b.name));
  for (const name of ['b1', 'b2', 'b3', 'b4']) await app.evaluate((_e, n) => globalThis.__companion.store.create(n), name);
  await page.getByTestId('board-picker').click();
  await page.keyboard.press('Escape');
  const row = (name: string) => boardRow(page, name).getByTestId('brief-board');
  await expect(page.getByTestId('brief-children').getByTestId('brief-board')).toHaveCount(5);
  const order = await page.getByTestId('brief-children').getByTestId('brief-board').allTextContents();

  // ⌘-click selects without opening. ⇧-click extends from there.
  const open = await page.getByTestId('board-picker').textContent();
  const [first, , third] = order.filter((n) => n !== open);
  await row(first).click({ modifiers: ['Meta'] });
  await expect(page.getByTestId('board-picker')).toHaveText(open!);
  await expect(page.getByTestId('board-selection')).toContainText('1 selected');
  await row(third).click({ modifiers: ['Shift'] });
  const span = order.slice(order.indexOf(first), order.indexOf(third) + 1);
  await expect(page.getByTestId('board-selection')).toContainText(`${span.length} selected`);
  for (const n of span) await expect(boardRow(page, n)).toHaveAttribute('data-selected', 'true');

  // Escape clears the selection, and the panel stays up.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('board-selection')).toHaveCount(0);
  expect(await app.evaluate(() => globalThis.__companion.panel.isVisible())).toBe(true);

  // A selected row's menu acts on the whole selection.
  await row(first).click({ modifiers: ['Meta'] });
  await row(third).click({ modifiers: ['Meta'] });
  await boardRowMenu(page, first);
  await expect(page.getByTestId('board-row-menu').getByRole('menuitem')).toHaveText(['File under…', 'Delete 2 boards']);
  await page.keyboard.press('Escape');

  // The bar asks before it deletes. Cancel keeps everything.
  await page.getByTestId('selection-delete').click();
  await expect(page.getByTestId('selection-menu')).toContainText('Delete 2 boards? They go to the Trash.');
  await page.getByTestId('selection-cancel').click();
  expect(await names()).toHaveLength(5);
  await page.getByTestId('selection-delete').click();
  await page.getByTestId('selection-confirm-delete').click();
  await expect.poll(names).toEqual(order.filter((n) => n !== first && n !== third).sort());
  await expect(page.getByTestId('board-selection')).toHaveCount(0);
  await page.screenshot({ path: join(RESULTS, 'board-rows.png') });
  await app.close();
});

test('with the sidebar hidden, a board deletes from the board menu after a second click, and deleting the open one opens another', async () => {
  const { app, page } = await launch(tempDataDir());
  await showPanel(app, page);
  const names = () => app.evaluate(() => globalThis.__companion.store.list().map((b) => b.name));
  const row = (name: string) => page.getByTestId('board-menu').locator('li', { has: page.getByTestId('board-item').filter({ hasText: new RegExp(`^${name}$`) }) });
  for (const name of ['second', 'third']) {
    await boardMenu(page, 'board-new');
    await page.getByTestId('board-name').fill(name);
    await page.getByTestId('board-name').press('Enter');
    await expect(page.getByTestId('board-picker')).toHaveText(name);
  }
  await page.getByTestId('sidebar-toggle').click();

  // The first click only asks; leaving the row takes the question back.
  await page.getByTestId('board-picker').click();
  await row('second').hover();
  await row('second').getByTestId('board-delete').click();
  await expect(row('second').getByTestId('board-delete')).toHaveText('Delete');
  expect(await names()).toEqual(['scratch', 'second', 'third']);
  await row('second').getByTestId('board-delete').click();
  await expect.poll(names).toEqual(['scratch', 'third']);
  await expect(page.getByTestId('board-item')).toHaveCount(2);
  await expect(page.getByTestId('board-picker')).toHaveText('third');

  // Deleting the open board moves to another first.
  await row('third').hover();
  await row('third').getByTestId('board-delete').click();
  await row('third').getByTestId('board-delete').click();
  await expect(page.getByTestId('board-picker')).toHaveText('scratch');
  await expect.poll(names).toEqual(['scratch']);
  await app.close();
});
