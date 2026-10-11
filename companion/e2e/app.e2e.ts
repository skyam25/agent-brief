import { expect, test } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtempSync, readlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import electronPath from 'electron';
import { backend, interactiveCanvas, launch, openNotes, penStroke, RESULTS, ROOT, sceneElements, showPanel, tempDataDir, testEnv } from './helpers';

const visible = (app: Awaited<ReturnType<typeof launch>>['app']) =>
  app.evaluate(() => (globalThis as any).__companion.panel.isVisible());

test('a second launch exits and shows the running panel', async () => {
  const dataDir = tempDataDir();
  const { app } = await launch(dataDir);
  expect(await visible(app)).toBe(false);
  const code = await new Promise<number | null>((resolve) => {
    const child = spawn(electronPath as unknown as string, [ROOT], { cwd: ROOT, env: testEnv(dataDir), stdio: 'ignore' });
    child.on('exit', resolve);
  });
  expect(code).toBe(0);
  await expect.poll(() => visible(app)).toBe(true);
  await app.close();
});

test('the app menu has About, Settings, Quit, the Edit roles and a Window menu', async () => {
  const { app } = await launch(tempDataDir());
  const menu = await app.evaluate(({ Menu }) =>
    Menu.getApplicationMenu()!.items.map((i) => ({
      label: i.label,
      role: i.role,
      items: i.submenu?.items.map((s) => s.role ?? s.label).filter(Boolean),
    })),
  );
  const edit = menu.find((m) => m.role?.toLowerCase() === 'editmenu')!;
  expect(edit.items!.map((r) => r!.toLowerCase())).toEqual(expect.arrayContaining(['undo', 'redo', 'cut', 'copy', 'paste', 'selectall']));
  const appMenu = menu.find((m) => m.role?.toLowerCase() === 'appmenu')!;
  expect(appMenu.items!.map((r) => r!.toLowerCase())).toEqual(
    expect.arrayContaining(['about', 'settings…', 'install command line tool…', 'quit']),
  );
  expect(menu.some((m) => m.role?.toLowerCase() === 'windowmenu')).toBe(true);
  const about = await app.evaluate(({ app }) => app.name);
  expect(about).toBe('Agent Brief');
  await app.close();
});

test('the panel follows macOS light and dark, and PNGs for Claude stay light', async () => {
  const { app, page } = await launch(tempDataDir());
  await showPanel(app, page);
  await backend(app, 'draw', 'current', { elements: [{ type: 'rectangle', x: 0, y: 0, label: 'Dark?' }] });
  await openNotes(page);

  const look = () =>
    page.evaluate(() => ({
      excalidraw: document.querySelector('.excalidraw')!.classList.contains('theme--dark') ? 'dark' : 'light',
      attr: document.documentElement.dataset.theme,
      strip: getComputedStyle(document.querySelector('.strip')!).backgroundColor || getComputedStyle(document.body).backgroundColor,
      body: getComputedStyle(document.body).backgroundColor,
      notes: getComputedStyle(document.querySelector('.notes textarea')!).color,
    }));
  const windowBg = () => app.evaluate(() => (globalThis as any).__companion.panel.win.getBackgroundColor());

  await app.evaluate(({ nativeTheme }) => (nativeTheme.themeSource = 'dark'));
  await expect.poll(async () => (await look()).excalidraw).toBe('dark');
  const dark = await look();
  expect(dark.attr).toBe('dark');
  expect(dark.body).toBe('rgb(18, 18, 18)');
  expect(dark.notes).toBe('rgb(227, 227, 232)');
  expect((await windowBg()).toLowerCase()).toBe('#121212');
  await page.getByTestId('settings-toggle').click();
  await page.screenshot({ path: join(RESULTS, 'theme-dark.png') });
  await page.getByTestId('settings-toggle').click();

  // Corner and centre pixels of the export are white and violet, as in light mode.
  const png = (await backend(app, 'png', 'current', {})).base64 as string;
  const pixels = await page.evaluate(async (b64) => {
    const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
    const bmp = await createImageBitmap(blob);
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = c.getContext('2d')!;
    ctx.drawImage(bmp, 0, 0);
    const corner = Array.from(ctx.getImageData(2, 2, 1, 1).data);
    const all = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
    let darkPixels = 0;
    for (let i = 0; i < all.length; i += 4) if (all[i] + all[i + 1] + all[i + 2] < 120) darkPixels++;
    return { corner, darkShare: darkPixels / (all.length / 4) };
  }, png);
  expect(pixels.corner).toEqual([255, 255, 255, 255]);
  expect(pixels.darkShare).toBeLessThan(0.05);

  await app.evaluate(({ nativeTheme }) => (nativeTheme.themeSource = 'light'));
  await expect.poll(async () => (await look()).excalidraw).toBe('light');
  const light = await look();
  expect(light.body).toBe('rgb(255, 255, 255)');
  expect((await windowBg()).toLowerCase()).toBe('#ffffff');
  await app.close();
});

test('settings change the hotkey live, report conflicts, and persist', async () => {
  const dataDir = tempDataDir();
  let { app, page } = await launch(dataDir);
  await showPanel(app, page);
  const registered = () => app.evaluate(() => [...(globalThis as any).__companion.registrar.registered.keys()]);
  expect(await registered()).toEqual(['Control+Alt+S']);

  await page.getByTestId('settings-toggle').click();
  // Test runs never update, so Settings shows the version without a check button.
  await expect(page.getByTestId('settings-update')).toContainText(/Version \d+\.\d+\.\d+/);
  await expect(page.getByTestId('settings-update-check')).toHaveCount(0);
  await page.getByTestId('settings-hotkey').fill('ctrl+shift+k');
  await page.getByTestId('settings-hotkey-save').click();
  await expect(page.getByTestId('settings-saved')).toBeVisible();
  expect(await registered()).toEqual(['Control+Shift+K']);

  await app.evaluate(() => (globalThis as any).__companion.registrar.taken.add('Command+Space'));
  await page.getByTestId('settings-hotkey').fill('Command+Space');
  await page.getByTestId('settings-hotkey-save').click();
  await expect(page.getByTestId('settings-error')).toHaveText(/already used/);
  expect(await registered()).toEqual(['Control+Shift+K']);

  await page.getByTestId('settings-hotkey').fill('Control+Banana');
  await page.getByTestId('settings-hotkey-save').click();
  await expect(page.getByTestId('settings-error')).toHaveText('Banana is not a key');

  await page.getByTestId('settings-mode').selectOption('fill');
  await page.getByTestId('settings-login').check();
  await expect(page.getByTestId('settings-saved')).toBeVisible();
  const delivery = await app.evaluate(async () => (await (globalThis as any).__companion.buildDelivery()).mode);
  expect(delivery).toBe('fill');

  const tray = await app.evaluate(() => (globalThis as any).__companion.trayMenu());
  expect(tray).toEqual([
    'Show Panel',
    'New Board',
    'Open on iPad…',
    'Toggle with ⌃⇧K',
    'separator',
    'Settings…',
    'Install Command Line Tool…',
    'separator',
    'Quit Agent Brief',
  ]);
  await app.close();

  ({ app, page } = await launch(dataDir));
  expect(await registered()).toEqual(['Control+Shift+K']);
  const settings = await page.evaluate(() => (window as any).companion.getSettings());
  expect(settings).toEqual({ hotkey: 'Control+Shift+K', deliveryMode: 'fill', openAtLogin: true });
  await app.close();
});

test('Escape hides the panel unless something on it wants the key', async () => {
  const { app, page } = await launch(tempDataDir());
  await showPanel(app, page);
  await backend(app, 'draw', 'current', { elements: [{ type: 'rectangle', id: 'r', x: 0, y: 0 }] });

  // Typing in the notes keeps the panel.
  await openNotes(page);
  await page.getByTestId('notes').focus();
  await page.keyboard.press('Escape');
  expect(await visible(app)).toBe(true);

  // A selection takes the first Escape.
  await page.evaluate(() => {
    const api = (window as any).__excalidraw;
    api.updateScene({ appState: { selectedElementIds: { r: true } } });
    (document.querySelector('.excalidraw') as HTMLElement).focus();
  });
  await expect.poll(() => page.evaluate(() => Object.keys((window as any).__excalidraw.getAppState().selectedElementIds))).toEqual(['r']);
  await page.keyboard.press('Escape');
  expect(await visible(app)).toBe(true);
  // Excalidraw uses later presses to step back out of the selection; once it is gone, Escape hides.
  await page.evaluate(() => (window as any).__excalidraw.updateScene({ appState: { selectedElementIds: {} } }));
  await expect.poll(() => page.evaluate(() => Object.keys((window as any).__excalidraw.getAppState().selectedElementIds).length)).toBe(0);
  await page.keyboard.press('Escape');
  await expect.poll(() => visible(app)).toBe(false);
  await app.close();
});

test('File > New Board opens the name field; the CLI installs into a temp home', async () => {
  const { app, page } = await launch(tempDataDir());
  await app.evaluate(({ Menu }) => {
    const file = Menu.getApplicationMenu()!.items.find((i) => i.label === 'File')!;
    file.submenu!.items.find((i) => i.label === 'New Board')!.click();
  });
  await expect(page.getByTestId('board-name')).toBeVisible();
  expect(await visible(app)).toBe(true);

  const home = mkdtempSync(join(tmpdir(), 'home-'));
  const result = await app.evaluate((_e, home) => (globalThis as any).__companion.installCli(home), home);
  expect(result.link).toBe(join(home, '.local/bin/agent-brief'));
  expect(readlinkSync(result.link)).toBe(join(ROOT, 'bin/agent-brief'));
  await app.close();
});

test('a denied microphone shows how to turn it on', async () => {
  const { app, page } = await launch(tempDataDir(), { COMPANION_TEST_MIC: 'denied' });
  await page.getByTestId('mic').click();
  await expect(page.getByTestId('send-status')).toHaveText(/Privacy & Security > Microphone/);
  await app.close();
});

test('remote elements merge in without entering undo history', async () => {
  const { app, page } = await launch(tempDataDir());
  await showPanel(app, page);
  const cdp = await page.context().newCDPSession(page);
  const box = (await interactiveCanvas(page).boundingBox())!;
  await penStroke(cdp, { x: box.x + 320, y: box.y + 300 }, { x: box.x + 600, y: box.y + 320 }, 0.6);
  await page.waitForTimeout(150);
  const stroke = (await sceneElements(page)).find((e) => e.type === 'freedraw');

  await page.evaluate(() => {
    const remote = { ...(window as any).__excalidraw.getSceneElements()[0], id: 'remote-1', x: 900, version: 5, versionNonce: 7, index: 'b0' };
    (window as any).__board.applyRemote('scratch', [remote]);
    (window as any).__board.applyRemote('other-board', [{ ...remote, id: 'elsewhere' }]);
  });
  let ids = (await sceneElements(page)).filter((e) => !e.isDeleted).map((e) => e.id);
  expect(ids.sort()).toEqual([stroke.id, 'remote-1'].sort());

  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  await page.waitForTimeout(150);
  ids = (await sceneElements(page)).filter((e) => !e.isDeleted).map((e) => e.id);
  expect(ids).toEqual(['remote-1']);
  await app.close();
});

test('while the panel is hidden only Claude and paired devices reach the timeline', async () => {
  const { app, page } = await launch(tempDataDir());
  await showPanel(app, page);
  await app.evaluate(() => (globalThis as any).__companion.panel.hide());
  await expect.poll(() => page.evaluate(() => (window as any).__board.panelVisible)).toBe(false);
  const logged = () =>
    page.evaluate(() => (window as any).__board.strokes.events.map((e: any) => `${e.by}:${e.elementId}${e.source ? `:${e.source}` : ''}`));

  await backend(app, 'draw', 'current', { elements: [{ type: 'rectangle', id: 'claude-box', x: 0, y: 0 }] });
  await expect.poll(logged).toEqual(['claude:claude-box']);

  // A change made on the hidden panel itself stays out.
  await page.evaluate(() => {
    const api = (window as any).__excalidraw;
    const base = api.getSceneElements()[0];
    api.updateScene({ elements: [...api.getSceneElementsIncludingDeleted(), { ...base, id: 'hidden-local', x: 200, customData: undefined, version: 2, versionNonce: 5, index: 'b3' }] });
  });
  await page.waitForTimeout(200);
  expect(await logged()).toEqual(['claude:claude-box']);

  // A stroke from a paired iPad arrives through applyRemote and counts.
  await page.evaluate(() => {
    const base = (window as any).__excalidraw.getSceneElements()[0];
    (window as any).__board.applyRemote('scratch', [{ ...base, id: 'from-ipad', x: 400, customData: undefined, version: 3, versionNonce: 9, index: 'b5' }]);
  });
  await expect.poll(logged).toEqual(['claude:claude-box', 'user:from-ipad:ipad']);
  await app.close();
});
