import { describe, expect, it } from 'vitest';
import { OFFSCREEN, panelWindow } from './window-options';

const spec = { preload: '/p.cjs', size: { width: 1100, height: 760 }, backgroundColor: '#121212' };

describe('panel window', () => {
  it('isolates and sandboxes the panel', () => {
    const plan = panelWindow({ ...spec, offscreen: false });
    expect(plan.options.webPreferences).toMatchObject({ contextIsolation: true, sandbox: true });
  });

  it('stays off screen and unfocused in tests', () => {
    const plan = panelWindow({ ...spec, offscreen: true });
    expect(plan.allWorkspaces).toBeUndefined();
    expect(plan.options).toMatchObject({ ...OFFSCREEN, focusable: false, frame: false, enableLargerThanScreen: true });
  });
});
