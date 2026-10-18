/** The panel: one window, created hidden and kept alive. */

import { app, BrowserWindow, screen } from 'electron';
import { areaUnder, centredBounds } from './placement';
import { OFFSCREEN, panelWindow } from './window-options';

const LONGEST_CROP = 900;

export interface PanelOptions {
  preload: string;
  /** Dev server URL, or undefined to load the built renderer file. */
  url?: string;
  file: string;
  size: { width: number; height: number };
  onResize: (size: { width: number; height: number }) => void;
  /** Called after the panel shows or hides. */
  onVisibility?: (visible: boolean) => void;
  /**
   * Keeps the window off every display, never focused and out of
   * the Dock. Tests use it so runs never disturb the person at the screen.
   */
  offscreen?: boolean;
  /** Matches the theme, so the window never flashes white in dark mode. */
  backgroundColor: string;
}

export class Panel {
  readonly win: BrowserWindow;
  readonly offscreen: boolean;
  private quitting = false;
  private readonly onVisibility: (visible: boolean) => void;

  constructor(opts: PanelOptions) {
    this.offscreen = !!opts.offscreen;
    this.onVisibility = opts.onVisibility ?? (() => {});
    const plan = panelWindow({
      preload: opts.preload,
      size: opts.size,
      backgroundColor: opts.backgroundColor,
      offscreen: this.offscreen,
    });
    this.win = new BrowserWindow(plan.options);
    if (plan.allWorkspaces) this.win.setVisibleOnAllWorkspaces(true, plan.allWorkspaces);

    let resizeTimer: NodeJS.Timeout | undefined;
    this.win.on('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (this.win.isDestroyed()) return;
        const [width, height] = this.win.getSize();
        opts.onResize({ width, height });
      }, 300);
    });

    this.win.on('close', (e) => {
      if (this.quitting) return;
      e.preventDefault();
      this.hide();
    });
    app.on('before-quit', () => {
      this.quitting = true;
    });

    // A page's beforeunload handler would cancel the quit.
    this.win.webContents.on('will-prevent-unload', (e) => {
      if (this.quitting) e.preventDefault();
    });

    if (opts.url) void this.win.loadURL(opts.url);
    else void this.win.loadFile(opts.file);
  }

  /** Lets the window close. An update install closes windows before `before-quit` fires. */
  prepareQuit(): void {
    this.quitting = true;
  }

  isVisible(): boolean {
    return !this.win.isDestroyed() && this.win.isVisible();
  }

  /** Shows the panel centred on the display under the cursor. Every show path goes through here. */
  show(): void {
    if (this.offscreen) {
      this.win.setPosition(OFFSCREEN.x, OFFSCREEN.y);
      this.win.showInactive();
      this.onVisibility(true);
      return;
    }
    const display = areaUnder(screen.getAllDisplays(), screen.getCursorScreenPoint());
    const [width, height] = this.win.getSize();
    this.win.setBounds(centredBounds(display.workArea, { width, height }));
    if (process.platform === 'darwin') app.show();
    this.win.show();
    this.win.focus();
    this.onVisibility(true);
  }

  hide(): void {
    this.win.hide();
    this.onVisibility(false);
    if (process.platform === 'darwin' && !this.offscreen) app.hide();
  }

  toggle(): void {
    if (this.isVisible()) this.hide();
    else this.show();
  }

  /** Part of the panel as a JPEG data URL, long edge 900 px or less. */
  async capture(raw: unknown): Promise<string | undefined> {
    const r = raw as { x?: unknown; y?: unknown; width?: unknown; height?: unknown } | null;
    const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : 0);
    const rect = { x: Math.max(0, n(r?.x)), y: Math.max(0, n(r?.y)), width: n(r?.width), height: n(r?.height) };
    if (rect.width < 4 || rect.height < 4) return undefined;
    let image = await this.win.webContents.capturePage(rect);
    if (image.isEmpty()) return undefined;
    const { width, height } = image.getSize();
    const scale = LONGEST_CROP / Math.max(width, height);
    if (scale < 1) image = image.resize({ width: Math.round(width * scale), height: Math.round(height * scale), quality: 'good' });
    return `data:image/jpeg;base64,${image.toJPEG(82).toString('base64')}`;
  }
}
