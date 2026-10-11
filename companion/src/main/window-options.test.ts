import { describe, expect, it } from 'vitest';
import { OFFSCREEN, panelWindow } from './window-options';

const spec = { preload: '/p.cjs', size: { width: 1100, height: 760 }, backgroundColor: '#121212' };

describe('panel window', () => {
  it('shows on every Space as a normal window and takes focus in the real app', () => {
    const plan = panelWindow({ ...spec, offscreen: false });
    expect(plan.allWorkspaces).toEqual({ visibleOnFullScreen: true, skipTransformProcessType: true });
    expect(plan.options).toMatchObject({
      show: false,
      focusable: true,
      frame: true,
      enableLargerThanScreen: false,
      acceptFirstMouse: true,
      paintWhenInitiallyHidden: true,
      backgroundColor: '#121212',
      width: 1100,
      height: 760,
      webPreferences: { preload: '/p.cjs', contextIsolation: true, sandbox: true, backgroundThrottling: false },
    });
    expect(plan.options.alwaysOnTop).toBeUndefined();
    expect(plan.options.x).toBeUndefined();
  });

  it('stays off screen and unfocused in tests', () => {
    const plan = panelWindow({ ...spec, offscreen: true });
    expect(plan.allWorkspaces).toBeUndefined();
    expect(plan.options).toMatchObject({ ...OFFSCREEN, focusable: false, frame: false, enableLargerThanScreen: true });
  });
});
