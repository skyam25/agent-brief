/** The panel: one window, created hidden and kept alive. */

import { app, BrowserWindow, Menu, screen, type MenuItemConstructorOptions } from 'electron';
import { areaUnder, centredBounds, reachable } from './placement';
import { textMenuTemplate } from './text-menu';
import { OFFSCREEN, panelWindow } from './window-options';

const LONGEST_CROP = 900;

export interface PanelOptions {
  preload: string;
  /** Dev server URL, or undefined to load the built renderer file. */
  url?: string;
  file: string;
  size: { width: number; height: number };
  /** Where the panel was last left. Without it, the first show centres the panel on the display under the cursor. */
  position?: { x: number; y: number };
  /** Called after the panel moves or resizes. The off-screen panel reports its size alone. */
  onBounds: (bounds: { width: number; height: number; x?: number; y?: number }) => void;
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
  /** The last text menu the off-screen panel would have shown. Tests read it, since the menu never pops up. */
  lastTextMenu: MenuItemConstructorOptions[] = [];
  private quitting = false;
  private placed: boolean;
  private readonly onVisibility: (visible: boolean) => void;

  constructor(opts: PanelOptions) {
    this.offscreen = !!opts.offscreen;
    this.onVisibility = opts.onVisibility ?? (() => {});
    this.placed = !!opts.position;
    const plan = panelWindow({
      preload: opts.preload,
      size: opts.size,
      position: opts.position,
      backgroundColor: opts.backgroundColor,
      offscreen: this.offscreen,
    });
    this.win = new BrowserWindow(plan.options);
    if (plan.allWorkspaces) this.win.setVisibleOnAllWorkspaces(true, plan.allWorkspaces);

    let boundsTimer: NodeJS.Timeout | undefined;
    const saveBounds = () => {
      clearTimeout(boundsTimer);
      boundsTimer = setTimeout(() => {
        if (this.win.isDestroyed()) return;
        const { x, y, width, height } = this.win.getBounds();
        opts.onBounds(this.offscreen ? { width, height } : { x, y, width, height });
      }, 300);
    };
    this.win.on('resize', saveBounds);
    this.win.on('move', saveBounds);

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

    // Right-clicks on text get spelling fixes and the edit actions.
    const contents = this.win.webContents;
    contents.on('context-menu', (_e, params) => {
      const template = textMenuTemplate(params, {
        replace: (word) => contents.replaceMisspelling(word),
        learn: (word) => contents.session.addWordToSpellCheckerDictionary(word),
      });
      if (this.offscreen) this.lastTextMenu = template;
      else if (template.length) Menu.buildFromTemplate(template).popup({ window: this.win, frame: params.frame ?? undefined });
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

  /**
   * Shows the panel where it was last left. An open panel stays put.
   * Every show path goes through here.
   */
  show(): void {
    if (this.offscreen) {
      this.win.setPosition(OFFSCREEN.x, OFFSCREEN.y);
      this.win.showInactive();
      this.onVisibility(true);
      return;
    }
    if (!this.win.isVisible()) this.place();
    if (process.platform === 'darwin') app.show();
    this.win.show();
    this.win.focus();
    this.onVisibility(true);
  }

  /** Centres the panel on the display under the cursor the first time, or when its spot is off every display. */
  private place(): void {
    const displays = screen.getAllDisplays();
    const bounds = this.win.getBounds();
    if (this.placed && reachable(displays.map((d) => d.workArea), bounds)) return;
    const display = areaUnder(displays, screen.getCursorScreenPoint());
    this.win.setBounds(centredBounds(display.workArea, bounds));
    this.placed = true;
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
