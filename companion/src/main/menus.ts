/** The app menu and the menu bar (tray) menu. */

import type { MenuItemConstructorOptions } from 'electron';
import type { Mode, UpdateStatus } from '../shared/ipc';
import { acceleratorLabel } from '../shared/accelerator';

export interface MenuActions {
  hotkey: string;
  captureHotkey: string;
  /** ⌘N makes a new board in Sketch mode and a new note in Write mode. */
  mode: Mode;
  togglePanel: () => void;
  showPanel: () => void;
  newBoard: () => void;
  newNote: () => void;
  openSettings: () => void;
  installCli: () => void;
  installPlugin: () => void;
  update: UpdateStatus;
  checkForUpdates: () => void;
  installUpdate: () => void;
}

/** Restart to Update once a download is ready, otherwise Check for Updates. Nothing in development. */
function updateItem(a: MenuActions): MenuItemConstructorOptions[] {
  const { state, available } = a.update;
  if (state === 'off') return [];
  if (state === 'ready') return [{ label: `Restart to Update to ${available}`, click: a.installUpdate }];
  return [{ label: 'Check for Updates…', enabled: state !== 'checking' && state !== 'downloading', click: a.checkForUpdates }];
}

/** The standard Edit menu is what makes ⌘C, ⌘V and ⌘Z work in Electron on macOS. */
export function appMenuTemplate(a: MenuActions): MenuItemConstructorOptions[] {
  return [
    {
      role: 'appMenu',
      submenu: [
        { role: 'about' },
        ...updateItem(a),
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'Command+,', click: a.openSettings },
        { label: 'Install Command Line Tool…', click: a.installCli },
        { label: 'Install Claude Code Plugin…', click: a.installPlugin },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        { label: 'New Board', accelerator: a.mode === 'sketch' ? 'Command+N' : undefined, click: a.newBoard },
        { label: 'New Note', accelerator: a.mode === 'write' ? 'Command+N' : undefined, click: a.newNote },
        { label: `Show or Hide Panel (${acceleratorLabel(a.hotkey)})`, click: a.togglePanel },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    { role: 'editMenu' },
    { role: 'windowMenu' },
  ];
}

export function trayMenuTemplate(a: MenuActions): MenuItemConstructorOptions[] {
  return [
    { label: 'Show Panel', click: a.showPanel },
    { label: 'New Board', click: a.newBoard },
    { label: `New Note (${acceleratorLabel(a.captureHotkey)})`, click: a.newNote },
    { label: `Toggle with ${acceleratorLabel(a.hotkey)}`, enabled: false },
    { type: 'separator' },
    { label: 'Settings…', click: a.openSettings },
    { label: 'Install Command Line Tool…', click: a.installCli },
    { label: 'Install Claude Code Plugin…', click: a.installPlugin },
    ...updateItem(a),
    { type: 'separator' },
    { label: 'Quit Agent Brief', role: 'quit' },
  ];
}
