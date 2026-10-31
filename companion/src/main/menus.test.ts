import type { MenuItemConstructorOptions } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import type { UpdateStatus } from '../shared/ipc';
import { appMenuTemplate, trayMenuTemplate, updateItems, type MenuActions } from './menus';

const actions = (update: Partial<UpdateStatus>): MenuActions => ({
  hotkey: 'Alt+Space',
  captureHotkey: 'Alt+Shift+Space',
  mode: 'sketch',
  togglePanel: vi.fn(),
  showPanel: vi.fn(),
  newBoard: vi.fn(),
  newNote: vi.fn(),
  openSettings: vi.fn(),
  find: vi.fn(),
  installCli: vi.fn(),
  installPlugin: vi.fn(),
  update: { version: '0.2.8', state: 'idle', ...update },
  updateNow: vi.fn(),
  installUpdate: vi.fn(),
});

const labels = (update: Partial<UpdateStatus>) =>
  updateItems(actions(update)).map((i) => [i.label, i.enabled !== false]);

describe('updateItems', () => {
  it('shows nothing when updates are off', () => {
    expect(labels({ state: 'off' })).toEqual([]);
  });

  it('offers a check when idle', () => {
    expect(labels({ state: 'idle' })).toEqual([['Check for Updates', true]]);
  });

  it('reports progress as disabled lines', () => {
    expect(labels({ state: 'checking' })).toEqual([['Checking for Updates…', false]]);
    expect(labels({ state: 'downloading', available: '0.2.9', percent: 42, restart: true })).toEqual([
      ['Downloading 0.2.9 (42%)…', false],
    ]);
    expect(labels({ state: 'downloading', available: '0.2.9', percent: 100, restart: true })).toEqual([
      ['Preparing 0.2.9…', false],
    ]);
  });

  it('offers to update after a background download', () => {
    const a = actions({ state: 'downloading', available: '0.2.9', percent: 42 });
    const items = updateItems(a);
    expect(items.map((i) => [i.label, i.enabled !== false])).toEqual([
      ['Downloading 0.2.9 (42%)…', false],
      ['Update When Downloaded', true],
    ]);
    (items[1].click as () => void)();
    expect(a.updateNow).toHaveBeenCalled();
  });

  it('says the app is current and offers another check', () => {
    expect(labels({ state: 'current' })).toEqual([
      ['Up to Date (0.2.8)', false],
      ['Check for Updates', true],
    ]);
  });

  it('offers a retry after an error', () => {
    expect(labels({ state: 'error', error: 'offline' })).toEqual([
      ['Could Not Check for Updates', false],
      ['Try Again', true],
    ]);
    expect(labels({ state: 'error', error: 'bad signature', available: '0.2.9' })).toEqual([
      ['Could Not Download 0.2.9', false],
      ['Try Again', true],
    ]);
  });

  it('offers the restart once a download is ready', () => {
    const a = actions({ state: 'ready', available: '0.2.9' });
    const [item] = updateItems(a);
    expect(item.label).toBe('Restart to Update to 0.2.9');
    (item.click as () => void)();
    expect(a.installUpdate).toHaveBeenCalled();
  });

  it('checks without opening the panel', () => {
    const a = actions({ state: 'idle' });
    (updateItems(a)[0].click as () => void)();
    expect(a.updateNow).toHaveBeenCalled();
    expect(a.openSettings).not.toHaveBeenCalled();
    expect(a.showPanel).not.toHaveBeenCalled();
  });
});

describe('trayMenuTemplate', () => {
  it('sets the update lines apart from the install items', () => {
    const items = trayMenuTemplate(actions({ state: 'current' })).map((i) => i.label ?? i.type);
    expect(items.slice(-5)).toEqual(['separator', 'Up to Date (0.2.8)', 'Check for Updates', 'separator', 'Quit Agent Brief']);
  });

  it('adds no extra separator when updates are off', () => {
    const items = trayMenuTemplate(actions({ state: 'off' })).map((i) => i.label ?? i.type);
    expect(items.slice(-3)).toEqual(['Install Claude Code Plugin…', 'separator', 'Quit Agent Brief']);
  });
});

describe('Edit menu', () => {
  const find = (mode: MenuActions['mode']) => {
    const edit = appMenuTemplate({ ...actions({}), mode }).find((m) => m.label === 'Edit');
    return (edit?.submenu as MenuItemConstructorOptions[]).find((i) => i.label === 'Find…');
  };

  it('keeps the standard items and adds Find with ⌘F', () => {
    const edit = appMenuTemplate(actions({})).find((m) => m.label === 'Edit');
    const roles = (edit?.submenu as MenuItemConstructorOptions[]).map((i) => i.role).filter(Boolean);
    expect(roles).toEqual(['undo', 'redo', 'cut', 'copy', 'paste', 'pasteAndMatchStyle', 'delete', 'selectAll']);
    expect(find('sketch')).toMatchObject({ accelerator: 'Command+F', enabled: true });
  });

  it('turns Find off where there is nothing to find', () => {
    expect(find('write')?.enabled).toBe(true);
    expect(find('review')?.enabled).toBe(true);
    expect(find('initiative')?.enabled).toBe(false);
  });
});
