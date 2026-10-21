import { beforeEach, describe, expect, it, vi } from 'vitest';

const left = { bounds: { x: 0, y: 0, width: 1440, height: 900 }, workArea: { x: 0, y: 25, width: 1440, height: 875 } };
const right = { bounds: { x: 1440, y: 0, width: 2560, height: 1440 }, workArea: { x: 1440, y: 25, width: 2560, height: 1415 } };

const fake = vi.hoisted(() => ({
  displays: [] as { bounds: object; workArea: object }[],
  cursor: { x: 0, y: 0 },
  win: undefined as unknown as FakeWindow,
}));

type Rect = { x: number; y: number; width: number; height: number };
type FakeWindow = {
  bounds: Rect;
  visible: boolean;
  handlers: Record<string, () => void>;
  setBounds: (b: Rect) => void;
};

vi.mock('electron', () => {
  class BrowserWindow {
    bounds: Rect;
    visible = false;
    handlers: Record<string, () => void> = {};
    webContents = { on: () => undefined };
    constructor(o: { x?: number; y?: number; width: number; height: number }) {
      this.bounds = { x: o.x ?? 0, y: o.y ?? 0, width: o.width, height: o.height };
      fake.win = this;
    }
    on(event: string, fn: () => void) {
      this.handlers[event] = fn;
    }
    setVisibleOnAllWorkspaces() {}
    loadFile() {
      return Promise.resolve();
    }
    isDestroyed() {
      return false;
    }
    isVisible() {
      return this.visible;
    }
    getBounds() {
      return { ...this.bounds };
    }
    setBounds(b: Rect) {
      this.bounds = { ...b };
    }
    show() {
      this.visible = true;
    }
    hide() {
      this.visible = false;
    }
    focus() {}
  }
  return {
    app: { on: () => undefined, show: () => undefined, hide: () => undefined },
    screen: { getAllDisplays: () => fake.displays, getCursorScreenPoint: () => fake.cursor },
    BrowserWindow,
  };
});

const { Panel } = await import('./panel');

const panel = (position?: { x: number; y: number }, onBounds = () => {}) =>
  new Panel({ preload: '/p.cjs', file: '/i.html', size: { width: 1100, height: 760 }, position, onBounds, backgroundColor: '#121212' });

beforeEach(() => {
  fake.displays = [left, right];
  fake.cursor = { x: 100, y: 100 };
});

describe('Panel placement', () => {
  it('centres the first show on the display under the cursor', () => {
    fake.cursor = { x: 2000, y: 500 };
    panel().show();
    expect(fake.win.bounds).toEqual({ x: 2170, y: 353, width: 1100, height: 760 });
  });

  it('stays where it was moved, whether open or shown again after a hide', () => {
    const p = panel();
    p.show();
    fake.win.setBounds({ x: 40, y: 60, width: 1100, height: 760 });
    fake.cursor = { x: 2000, y: 500 };
    p.show();
    expect(fake.win.bounds).toMatchObject({ x: 40, y: 60 });
    p.hide();
    p.show();
    expect(fake.win.bounds).toMatchObject({ x: 40, y: 60 });
  });

  it('opens at the saved spot, and centres again when that display is gone', () => {
    panel({ x: 1600, y: 80 }).show();
    expect(fake.win.bounds).toMatchObject({ x: 1600, y: 80 });

    fake.displays = [left];
    panel({ x: 1600, y: 80 }).show();
    expect(fake.win.bounds).toEqual({ x: 170, y: 83, width: 1100, height: 760 });
  });

  it('reports where the panel moved to', () => {
    vi.useFakeTimers();
    const onBounds = vi.fn();
    panel(undefined, onBounds);
    fake.win.setBounds({ x: 40, y: 60, width: 900, height: 640 });
    fake.win.handlers.move();
    vi.advanceTimersByTime(300);
    expect(onBounds).toHaveBeenCalledWith({ x: 40, y: 60, width: 900, height: 640 });
    vi.useRealTimers();
  });
});
