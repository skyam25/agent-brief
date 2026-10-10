import { describe, expect, it } from 'vitest';
import { OFFSCREEN, panelWindow } from './window-options';

const spec = { preload: '/p.cjs', size: { width: 1100, height: 760 }, backgroundColor: '#121212' };

describe('panel window', () => {
  it('floats on top of every Space and takes focus in the real app', () => {
    const plan = panelWindow({ ...spec, offscreen: false });
    expect(plan.topLevel).toBe('floating');
    expect(plan.allWorkspaces).toEqual({ visibleOnFullScreen: true, skipTransformProcessType: true });
    expect(plan.options).toMatchObject({
      show: false,
      alwaysOnTop: true,
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
    expect(plan.options.x).toBeUndefined();
  });

  it('stays off screen, unfocused and below other windows in tests', () => {
    const plan = panelWindow({ ...spec, offscreen: true });
    expect(plan.topLevel).toBeUndefined();
    expect(plan.allWorkspaces).toBeUndefined();
    expect(plan.options).toMatchObject({ ...OFFSCREEN, alwaysOnTop: false, focusable: false, frame: false, enableLargerThanScreen: true });
  });
});
