import { expect, test } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { FractionalIndex } from '@excalidraw/excalidraw/element/types';
import electronPath from 'electron';
import { backend, interactiveCanvas, launch, openNotes, penStroke, RESULTS, ROOT, sceneElements, showPanel, tempDataDir, testEnv, typeDraft } from './helpers';

const visible = (app: Awaited<ReturnType<typeof launch>>['app']) =>
  app.evaluate(() => globalThis.__companion.panel.isVisible());

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
  const windowBg = () => app.evaluate(() => globalThis.__companion.panel.win.getBackgroundColor());

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
  const registered = () => app.evaluate(() => [...globalThis.__companion.registrar.registered.keys()].sort());
  expect(await registered()).toEqual(['Control+Alt+N', 'Control+Alt+S']);

  await page.getByTestId('settings-toggle').click();
  // Test runs never update, so Settings shows the version without a check button.
  await expect(page.getByTestId('settings-update')).toContainText(/Version \d+\.\d+\.\d+/);
  await expect(page.getByTestId('settings-update-check')).toHaveCount(0);
  // A shortcut chip records the next key press and shows it as macOS writes it.
  await expect(page.getByTestId('settings-hotkey')).toHaveText('⌃⌥S');
  await page.getByTestId('settings-hotkey').click();
  await expect(page.getByTestId('settings-hotkey')).toHaveText('Press keys…');
  await page.keyboard.press('Control+Shift+K');
  await expect(page.getByTestId('settings-saved')).toBeVisible();
  await expect(page.getByTestId('settings-hotkey')).toHaveText('⌃⇧K');
  expect(await registered()).toEqual(['Control+Alt+N', 'Control+Shift+K']);

  await app.evaluate(() => globalThis.__companion.registrar.taken.add('Command+Space'));
  await page.getByTestId('settings-hotkey').click();
  await page.keyboard.press('Meta+Space');
  await expect(page.getByTestId('settings-error')).toHaveText(/already used/);
  expect(await registered()).toEqual(['Control+Alt+N', 'Control+Shift+K']);

  // A key without a modifier asks for one, and Escape keeps the shortcut.
  await page.getByTestId('settings-hotkey').click();
  await page.keyboard.press('KeyS');
  await expect(page.getByTestId('settings-hotkey')).toHaveText('Hold ⌃, ⌥ or ⌘ with the key');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('settings-hotkey')).toHaveText('⌃⇧K');
  await expect(page.getByTestId('settings')).toBeVisible();

  await page.getByTestId('settings-mode').selectOption('fill');

  // Appearance pins the panel and the board to one theme, whatever macOS shows.
  const themes = () =>
    page.evaluate(() => [document.documentElement.dataset.theme, window.__excalidraw.getAppState().theme]);
  await page.getByTestId('settings-appearance').selectOption('light');
  await expect.poll(themes).toEqual(['light', 'light']);
  await page.getByTestId('settings-appearance').selectOption('dark');
  await expect.poll(themes).toEqual(['dark', 'dark']);

  await page.getByTestId('settings-login').check();
  await expect(page.getByTestId('settings-saved')).toBeVisible();
  const delivery = await app.evaluate(async () => (await globalThis.__companion.buildDelivery()).mode);
  expect(delivery).toBe('fill');

  const tray = await app.evaluate(() => globalThis.__companion.trayMenu());
  expect(tray).toEqual([
    'Show Panel',
    'New Board',
    'New Note (⌃⌥N)',
    'Toggle with ⌃⇧K',
    'separator',
    'Settings…',
    'Install Command Line Tool…',
    'Install Claude Code Plugin…',
    'separator',
    'Quit Agent Brief',
  ]);
  await app.close();

  ({ app, page } = await launch(dataDir));
  expect(await registered()).toEqual(['Control+Alt+N', 'Control+Shift+K']);
  const settings = await page.evaluate(() => window.companion.getSettings());
  expect(settings).toEqual({ hotkey: 'Control+Shift+K', deliveryMode: 'fill', openAtLogin: true, captureHotkey: 'Control+Alt+N', appearance: 'dark' });
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');
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
    const api = window.__excalidraw;
    api.updateScene({ appState: { selectedElementIds: { r: true } } });
    (document.querySelector('.excalidraw') as HTMLElement).focus();
  });
  await expect.poll(() => page.evaluate(() => Object.keys(window.__excalidraw.getAppState().selectedElementIds))).toEqual(['r']);
  await page.keyboard.press('Escape');
  expect(await visible(app)).toBe(true);
  // Excalidraw uses later presses to step back out of the selection; once it is gone, Escape hides.
  await page.evaluate(() => window.__excalidraw.updateScene({ appState: { selectedElementIds: {} } }));
  await expect.poll(() => page.evaluate(() => Object.keys(window.__excalidraw.getAppState().selectedElementIds).length)).toBe(0);
  await page.keyboard.press('Escape');
  await expect.poll(() => visible(app)).toBe(false);
  await app.close();
});

test('File > New Board opens the name field; the CLI installs into a temp home and the plugin through claude, linking the CLI too', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-'));
  const log = join(dir, 'calls.log');
  const claude = join(dir, 'claude');
  writeFileSync(claude, `#!/bin/sh\necho "$*" >> '${log}'\ncase "$*" in *--json) echo '[]' ;; esac\n`, { mode: 0o755 });

  const { app, page } = await launch(tempDataDir(), { COMPANION_TEST_CLAUDE: claude });
  await app.evaluate(({ Menu }) => {
    const file = Menu.getApplicationMenu()!.items.find((i) => i.label === 'File')!;
    file.submenu!.items.find((i) => i.label === 'New Board')!.click();
  });
  await expect(page.getByTestId('board-name')).toBeVisible();
  expect(await visible(app)).toBe(true);

  const home = mkdtempSync(join(tmpdir(), 'home-'));
  const result = (await app.evaluate((_e, home) => globalThis.__companion.installCli(home), home))!;
  expect(result.link).toBe(join(home, '.local/bin/agent-brief'));
  expect(readlinkSync(result.link)).toBe(join(ROOT, 'bin/agent-brief'));

  // The plugin installs from the repo marketplace and links the CLI with it.
  const pluginHome = mkdtempSync(join(tmpdir(), 'home-'));
  const plugin = (await app.evaluate((_e, home) => globalThis.__companion.installPlugin(home), pluginHome))!;
  expect(plugin.installed).toBe(true);
  expect(plugin.cliError).toBeUndefined();
  expect(readlinkSync(join(pluginHome, '.local/bin/agent-brief'))).toBe(join(ROOT, 'bin/agent-brief'));
  expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual([
    `plugin marketplace add ${resolve(ROOT, '..')}`,
    'plugin list --json',
    'plugin install agent-brief@agent-brief',
  ]);
  await app.close();
});

test('the app menu has About, Settings, Quit, Edit roles and a Window menu; ⌘N makes a board or a note by mode', async () => {
  const { app, page } = await launch(tempDataDir());
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

  await showPanel(app, page);

  // The item that holds ⌘N follows the mode, and clicking it is what the key does.
  const cmdN = () =>
    app.evaluate(({ Menu }) => {
      const file = Menu.getApplicationMenu()!.items.find((i) => i.label === 'File')!;
      const item = file.submenu!.items.find((i) => i.accelerator === 'Command+N')!;
      return item.label;
    });
  const pressCmdN = () =>
    app.evaluate(({ Menu }) => {
      const file = Menu.getApplicationMenu()!.items.find((i) => i.label === 'File')!;
      file.submenu!.items.find((i) => i.accelerator === 'Command+N')!.click();
    });

  expect(await cmdN()).toBe('New Board');
  await pressCmdN();
  await expect(page.getByTestId('board-name')).toBeVisible();
  await page.keyboard.press('Escape');

  await page.getByTestId('mode-write').click();
  await expect.poll(cmdN).toBe('New Note');

  // An empty note is reused, so the open one needs text first.
  await typeDraft(page, 'first thought');
  await expect(page.getByTestId('draft-row')).toHaveCount(1);
  await pressCmdN();
  await expect(page.getByTestId('draft-row')).toHaveCount(2);
  await expect(page.getByTestId('draft-body')).toHaveText('');
  await app.close();
});

test('a denied microphone shows how to turn it on', async () => {
  const { app, page } = await launch(tempDataDir(), { COMPANION_TEST_MIC: 'denied' });
  await page.getByTestId('mic').click();
  await expect(page.getByTestId('send-status')).toHaveText(/Privacy & Security > Microphone/);
  await app.close();
});

test('while the panel is hidden only Claude reaches the timeline', async () => {
  const { app, page } = await launch(tempDataDir());
  await showPanel(app, page);
  await app.evaluate(() => globalThis.__companion.panel.hide());
  await expect.poll(() => page.evaluate(() => window.__board.panelVisible)).toBe(false);
  const logged = () =>
    page.evaluate(() => window.__board.strokes.events.map((e) => `${e.by}:${e.elementId}`));

  await backend(app, 'draw', 'current', { elements: [{ type: 'rectangle', id: 'claude-box', x: 0, y: 0 }] });
  await expect.poll(logged).toEqual(['claude:claude-box']);

  // A change made on the hidden panel itself stays out.
  await page.evaluate(() => {
    const api = window.__excalidraw;
    const base = api.getSceneElements()[0];
    api.updateScene({ elements: [...api.getSceneElementsIncludingDeleted(), { ...base, id: 'hidden-local', x: 200, customData: undefined, version: 2, versionNonce: 5, index: 'b3' as FractionalIndex }] });
  });
  await page.waitForTimeout(200);
  expect(await logged()).toEqual(['claude:claude-box']);
  await app.close();
});
