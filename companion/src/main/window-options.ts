/** How the panel window is built and layered, for the real app and for tests. */

import type { BrowserWindowConstructorOptions } from 'electron';

/** Far outside any display. */
export const OFFSCREEN = { x: -20000, y: -20000 };

export interface WindowSpec {
  preload: string;
  size: { width: number; height: number };
  backgroundColor: string;
  offscreen: boolean;
}

export interface WindowPlan {
  options: BrowserWindowConstructorOptions;
  /** Options for `setVisibleOnAllWorkspaces(true, …)`, or undefined to stay on one Space. */
  allWorkspaces?: { visibleOnFullScreen: boolean; skipTransformProcessType: boolean };
}

/**
 * The real panel is a normal window on every Space. It comes to the front when
 * shown, and other windows can cover it. The test panel sits off every display,
 * never focused.
 */
export function panelWindow(spec: WindowSpec): WindowPlan {
  const off = spec.offscreen;
  return {
    options: {
      show: false,
      ...(off ? OFFSCREEN : {}),
      width: spec.size.width,
      height: spec.size.height,
      minWidth: 480,
      minHeight: 360,
      title: 'Agent Brief',
      focusable: !off,
      // macOS pulls windows back on screen; a frameless window that may be larger than the screen stays put.
      frame: !off,
      enableLargerThanScreen: off,
      acceptFirstMouse: true,
      fullscreenable: false,
      paintWhenInitiallyHidden: true,
      backgroundColor: spec.backgroundColor,
      webPreferences: {
        preload: spec.preload,
        contextIsolation: true,
        sandbox: true,
        backgroundThrottling: false,
      },
    },
    allWorkspaces: off ? undefined : { visibleOnFullScreen: true, skipTransformProcessType: true },
  };
}
