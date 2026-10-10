/** The app menu and the menu bar (tray) menu. */

import type { MenuItemConstructorOptions } from 'electron';
import { acceleratorLabel } from './accelerator';

export interface MenuActions {
  hotkey: string;
  togglePanel: () => void;
  showPanel: () => void;
  newBoard: () => void;
  openSettings: () => void;
  installCli: () => void;
  openIpad: () => void;
}

/** The standard Edit menu is what makes ⌘C, ⌘V and ⌘Z work in Electron on macOS. */
export function appMenuTemplate(a: MenuActions): MenuItemConstructorOptions[] {
  return [
    {
      role: 'appMenu',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'Command+,', click: a.openSettings },
        { label: 'Install Command Line Tool…', click: a.installCli },
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
        { label: 'New Board', accelerator: 'Command+N', click: a.newBoard },
        { label: 'Open on iPad…', click: a.openIpad },
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
    { label: 'Open on iPad…', click: a.openIpad },
    { label: `Toggle with ${acceleratorLabel(a.hotkey)}`, enabled: false },
    { type: 'separator' },
    { label: 'Settings…', click: a.openSettings },
    { label: 'Install Command Line Tool…', click: a.installCli },
    { type: 'separator' },
    { label: 'Quit Agent Brief', role: 'quit' },
  ];
}
