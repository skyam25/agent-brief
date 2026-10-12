/** Ways into the panel from outside it: the hotkeys, the app menu, the tray and the Dock, and the settings that drive them. */

import { join } from 'node:path';
import { app, globalShortcut, Menu, nativeImage, nativeTheme, Tray } from 'electron';
import type { CompanionServer } from '../server/index';
import { CH, type Settings, type SettingsResult } from '../shared/ipc';
import { FakeRegistrar, Hotkey, type Registrar } from './hotkey';
import type { Installs } from './installs';
import { appMenuTemplate, trayMenuTemplate, type MenuActions } from './menus';
import type { Panel } from './panel';
import type { StateFile } from './store';
import type { Updater } from './updater';

export interface ControlsOptions {
  testMode: boolean;
  state: StateFile;
  panel: Panel;
  server: Pick<CompanionServer, 'setTarget'>;
  installs: Installs;
  updater: Updater;
  send: (channel: string, ...args: unknown[]) => void;
  setPrompt: (text: string | undefined) => void;
}

export interface Controls {
  hotkey: Hotkey;
  registrar: Registrar;
  /** Shows the panel from the hotkey, menus or Dock. Opening it this way picks no session. */
  openStandalone(): void;
  /** Opens Write mode on a new note, from the capture shortcut and menus. A new thought picks no session, even with the panel up. */
  newNote(): void;
  togglePanel(): void;
  actions(): MenuActions;
  buildMenus(): void;
  settings(): Settings;
  applySettings(patch: Partial<Settings>): SettingsResult;
}

/** Registers the hotkeys, puts up the tray and builds the menus. */
export function createControls(opts: ControlsOptions): Controls {
  const { testMode, state, panel, server, installs, updater, send, setPrompt } = opts;

  const settings = (): Settings => ({
    hotkey: state.state.hotkey,
    deliveryMode: state.state.deliveryMode,
    openAtLogin: state.state.openAtLogin,
    captureHotkey: state.state.captureHotkey,
    appearance: state.state.appearance,
  });

  const openStandalone = () => {
    if (!panel.isVisible()) {
      server.setTarget(undefined);
      setPrompt(undefined);
    }
    panel.show();
  };

  // Tests use a registrar that grabs nothing, so they never take the user's shortcut.
  const registrar: Registrar = testMode
    ? new FakeRegistrar()
    : { register: (a, fn) => globalShortcut.register(a, fn), unregister: (a) => globalShortcut.unregister(a) };
  const togglePanel = () => (panel.isVisible() ? panel.hide() : openStandalone());
  const hotkey = new Hotkey(registrar, togglePanel);
  const startup = hotkey.set(state.state.hotkey);
  if (!startup.ok) console.warn(`[companion] ${startup.error}`);
  const newNote = () => {
    server.setTarget(undefined);
    setPrompt(undefined);
    panel.show();
    send(CH.newNote);
  };
  const captureKey = new Hotkey(registrar, newNote);
  const captureStartup = captureKey.set(state.state.captureHotkey);
  if (!captureStartup.ok) console.warn(`[companion] ${captureStartup.error}`);

  const actions = (): MenuActions => ({
    hotkey: state.state.hotkey,
    captureHotkey: state.state.captureHotkey,
    mode: state.state.mode,
    newNote,
    togglePanel,
    showPanel: openStandalone,
    newBoard: () => {
      openStandalone();
      send(CH.newBoard);
    },
    openSettings: () => {
      openStandalone();
      send(CH.openSettings);
    },
    installCli: () => void installs.installCli({ confirm: true }),
    installPlugin: () => void installs.installPlugin({ confirm: true }),
    update: updater.current(),
    checkForUpdates: () => void updater.check(),
    installUpdate: () => void updater.install(),
  });

  let tray: Tray | undefined;
  const buildMenus = () => {
    Menu.setApplicationMenu(Menu.buildFromTemplate(appMenuTemplate(actions())));
    tray?.setContextMenu(Menu.buildFromTemplate(trayMenuTemplate(actions())));
  };
  // The real tray stays out of test runs; tests inspect the template instead.
  if (!testMode) {
    const icons = join(app.getAppPath(), 'build/icons');
    const trayImage = nativeImage.createFromPath(join(icons, 'trayTemplate.png'));
    tray = new Tray(trayImage);
    if (trayImage.isEmpty()) tray.setTitle('✎');
    tray.setToolTip('Agent Brief');
    if (!app.isPackaged) app.dock?.setIcon(join(icons, 'icon-1024.png'));
  }
  buildMenus();

  const applySettings = (patch: Partial<Settings>): SettingsResult => {
    const next: Partial<Settings> = {};
    if (patch.hotkey !== undefined) {
      const r = hotkey.set(patch.hotkey);
      if (!r.ok) return { ok: false, error: r.error, settings: settings() };
      next.hotkey = r.hotkey;
    }
    if (patch.captureHotkey !== undefined) {
      const r = captureKey.set(patch.captureHotkey);
      if (!r.ok) return { ok: false, error: r.error, settings: settings() };
      next.captureHotkey = r.hotkey;
    }
    if (patch.deliveryMode !== undefined) {
      if (patch.deliveryMode !== 'fill' && patch.deliveryMode !== 'submit') {
        return { ok: false, error: 'Delivery mode is fill or submit', settings: settings() };
      }
      next.deliveryMode = patch.deliveryMode;
    }
    if (patch.appearance !== undefined) {
      if (!['system', 'light', 'dark'].includes(patch.appearance)) {
        return { ok: false, error: 'Appearance is system, light or dark', settings: settings() };
      }
      next.appearance = patch.appearance;
    }
    if (patch.openAtLogin !== undefined) {
      next.openAtLogin = !!patch.openAtLogin;
      // An unpackaged build would register the bare Electron binary, so only the real app does this.
      if (!testMode && app.isPackaged) app.setLoginItemSettings({ openAtLogin: next.openAtLogin });
    }
    state.update(next);
    // Setting the source fires nativeTheme's `updated`, which repaints the panel.
    if (next.appearance) nativeTheme.themeSource = next.appearance;
    buildMenus();
    return { ok: true, settings: settings() };
  };

  return { hotkey, registrar, openStandalone, newNote, togglePanel, actions, buildMenus, settings, applySettings };
}
