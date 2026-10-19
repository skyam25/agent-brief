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
  /** Opens the find of the view on show. */
  find: () => void;
  installCli: () => void;
  installPlugin: () => void;
  update: UpdateStatus;
  updateNow: () => void;
  installUpdate: () => void;
}

/**
 * The update status and its action. Checks run in the background, so the
 * menu reports progress itself and never opens the panel. A check from the
 * menu downloads, then asks before it restarts. Nothing in development.
 */
export function updateItems(a: MenuActions): MenuItemConstructorOptions[] {
  const { state, available, percent, restart } = a.update;
  const check: MenuItemConstructorOptions = { label: 'Check for Updates', click: a.updateNow };
  const status = (label: string): MenuItemConstructorOptions => ({ label, enabled: false });
  switch (state) {
    case 'off':
      return [];
    case 'checking':
      return [status('Checking for Updates…')];
    case 'downloading': {
      const progress = `${available ?? 'Update'}${percent ? ` (${percent}%)` : ''}`;
      return restart
        ? [status(`Downloading ${progress}…`)]
        : [status(`Downloading ${progress}…`), { label: 'Update When Downloaded', click: a.updateNow }];
    }
    case 'ready':
      return [{ label: `Restart to Update to ${available}`, click: a.installUpdate }];
    case 'current':
      return [status(`Up to Date (${a.update.version})`), check];
    case 'error':
      return [status('Could Not Check for Updates'), { ...check, label: 'Try Again' }];
    default:
      return [check];
  }
}

/** The standard Edit menu is what makes ⌘C, ⌘V and ⌘Z work in Electron on macOS. */
export function appMenuTemplate(a: MenuActions): MenuItemConstructorOptions[] {
  return [
    {
      role: 'appMenu',
      submenu: [
        { role: 'about' },
        ...updateItems(a),
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
    {
      role: 'editMenu',
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' },
        { type: 'separator' },
        // Each view also takes ⌘F itself, so opening twice must be harmless.
        { label: 'Find…', accelerator: 'Command+F', enabled: a.mode !== 'initiative', click: a.find },
      ],
    },
    { role: 'windowMenu' },
  ];
}

export function trayMenuTemplate(a: MenuActions): MenuItemConstructorOptions[] {
  const update = updateItems(a);
  return [
    { label: 'Show Panel', click: a.showPanel },
    { label: 'New Board', click: a.newBoard },
    { label: `New Note (${acceleratorLabel(a.captureHotkey)})`, click: a.newNote },
    { label: `Toggle with ${acceleratorLabel(a.hotkey)}`, enabled: false },
    { type: 'separator' },
    { label: 'Settings…', click: a.openSettings },
    { label: 'Install Command Line Tool…', click: a.installCli },
    { label: 'Install Claude Code Plugin…', click: a.installPlugin },
    ...(update.length ? [{ type: 'separator' } as const, ...update] : []),
    { type: 'separator' },
    { label: 'Quit Agent Brief', role: 'quit' },
  ];
}
