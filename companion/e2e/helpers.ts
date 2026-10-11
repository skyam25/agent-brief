import { existsSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';

export const ROOT = resolve(import.meta.dirname, '..');
export const RESULTS = join(ROOT, 'test-results');
mkdirSync(RESULTS, { recursive: true });

export function tempDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'companion-e2e-'));
}

export interface Launched {
  app: ElectronApplication;
  page: Page;
}

/** Starts the built app in test mode against `dataDir` and waits for the board to be ready. */
export function testEnv(dataDir: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    COMPANION_TEST: '1',
    COMPANION_DATA_DIR: dataDir,
    COMPANION_SOCKET: join(dataDir, 'companion.sock'),
    ...extra,
  };
}

export async function launch(dataDir: string, extraEnv: Record<string, string> = {}): Promise<Launched> {
  const app = await electron.launch({ args: [ROOT], cwd: ROOT, env: testEnv(dataDir, extraEnv) });
  const page = await app.firstWindow();
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.log(`[renderer ${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', (e) => console.log(`[renderer error] ${e.message}`));
  await page.waitForFunction(() => !!(window as any).__board?.api, undefined, { timeout: 30_000 });
  return { app, page };
}

/** Shows the panel through the same function the global shortcut calls. */
export async function showPanel(app: ElectronApplication, page?: Page): Promise<void> {
  await app.evaluate(() => {
    const c = (globalThis as any).__companion;
    if (!c.panel.isVisible()) c.toggle();
  });
  if (page) {
    await page.waitForFunction(() => document.visibilityState === 'visible');
    await page.waitForTimeout(250);
  }
}

/** Opens the notes pane, which starts collapsed. */
export async function openNotes(page: Page): Promise<void> {
  const toggle = page.getByTestId('notes-toggle');
  if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click();
  await page.getByTestId('notes').waitFor();
}

/** Opens the board menu and runs New board or Rename from its foot. */
export async function boardMenu(page: Page, action: 'board-new' | 'board-rename'): Promise<void> {
  await page.getByTestId('board-picker').click();
  await page.getByTestId(action).click();
}

/** Switches boards through the board menu. */
export async function pickBoard(page: Page, name: string): Promise<void> {
  await page.getByTestId('board-picker').click();
  await page.getByTestId('board-item').filter({ hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }).click();
}

/** Opens Send's chooser and sends to the running session whose row shows `title`. */
export async function sendToSession(page: Page, title: string): Promise<void> {
  await page.getByTestId('send').click();
  await page.getByTestId('send-to-session').filter({ hasText: title }).click();
}

/** Calls a BoardBackend method in the main process. */
export function backend<T = any>(app: ElectronApplication, method: string, ...args: unknown[]): Promise<T> {
  return app.evaluate(
    async (_electron, { method, args }) => {
      const result = await (globalThis as any).__companion.backend[method](...args);
      return Buffer.isBuffer(result) ? { base64: result.toString('base64') } : result;
    },
    { method, args },
  ) as Promise<T>;
}

/** Scene elements in the renderer, including deleted ones. */
export function sceneElements(page: Page): Promise<any[]> {
  return page.evaluate(() => (window as any).__excalidraw.getSceneElementsIncludingDeleted());
}

/** The canvas Excalidraw draws on and takes input from. */
export function interactiveCanvas(page: Page) {
  return page.locator('canvas.excalidraw__canvas.interactive');
}

/** Picks the pen, as the person would before drawing. The board opens on the pointer. */
export async function pickPen(page: Page): Promise<void> {
  await page.evaluate(() => (window as any).__excalidraw.setActiveTool({ type: 'freedraw' }));
}

export type Cdp = Awaited<ReturnType<ReturnType<Page['context']>['newCDPSession']>>;

/** Draws a straight pen stroke through CDP with a fixed force (0..1). */
export async function penStroke(
  cdp: Cdp,
  from: { x: number; y: number },
  to: { x: number; y: number },
  force: number,
  steps = 16,
): Promise<void> {
  const at = (i: number) => ({ x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps });
  const send = (type: string, p: { x: number; y: number }, extra: object) =>
    cdp.send('Input.dispatchMouseEvent', { type, ...p, pointerType: 'pen', ...extra } as never);
  await send('mouseMoved', from, { force: 0 });
  await send('mousePressed', from, { button: 'left', buttons: 1, clickCount: 1, force });
  for (let i = 1; i <= steps; i++) await send('mouseMoved', at(i), { button: 'left', buttons: 1, force });
  await send('mouseReleased', to, { button: 'left', buttons: 0, force: 0 });
}

/** Dispatches synthetic pointer events, for inputs CDP cannot send (eraser button, touch). */
export async function syntheticStroke(
  page: Page,
  points: { x: number; y: number }[],
  init: { pointerType: 'pen' | 'touch'; button: number; buttons: number; pointerId: number; pressure?: number },
): Promise<void> {
  await page.evaluate(
    async ({ points, init }) => {
      const frame = () => new Promise((r) => requestAnimationFrame(r));
      const canvas = document.querySelector('canvas.excalidraw__canvas.interactive')!;
      // Synthetic pointers are not "active", so pointer capture throws. Real input never hits this.
      const proto = Element.prototype as any;
      if (!proto.__captureWrapped) {
        const original = proto.setPointerCapture;
        proto.setPointerCapture = function (id: number) {
          try {
            original.call(this, id);
          } catch {
            // ignore
          }
        };
        proto.__captureWrapped = true;
      }
      const fire = (type: string, p: { x: number; y: number }, extra: Partial<PointerEventInit>) => {
        const target = document.elementFromPoint(p.x, p.y) ?? canvas;
        target.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            composed: true,
            clientX: p.x,
            clientY: p.y,
            isPrimary: true,
            pressure: init.pressure ?? 0.5,
            pointerType: init.pointerType,
            pointerId: init.pointerId,
            ...extra,
          }),
        );
      };
      fire('pointerdown', points[0], { button: init.button, buttons: init.buttons });
      for (const p of points.slice(1)) {
        await frame();
        fire('pointermove', p, { button: -1, buttons: init.buttons });
      }
      await frame();
      fire('pointerup', points[points.length - 1], { button: init.button, buttons: 0 });
    },
    { points, init },
  );
}

/**
 * Ink thickness where the static canvas column at `clientX` crosses `clientY`,
 * in CSS pixels. Sums darkness so anti-aliased edges count fractionally.
 */
export function inkWidthAt(page: Page, clientX: number, clientY: number, window = 40): Promise<number> {
  return page.evaluate(
    ({ clientX, clientY, window }) => {
      const canvas = document.querySelector('canvas.excalidraw__canvas.static') as HTMLCanvasElement;
      const rect = canvas.getBoundingClientRect();
      const scale = canvas.width / rect.width;
      const x = Math.round((clientX - rect.left) * scale);
      const cy = Math.round((clientY - rect.top) * scale);
      const span = Math.round(window * scale);
      const data = canvas.getContext('2d')!.getImageData(x, cy - span, 1, span * 2).data;
      let ink = 0;
      for (let i = 0; i < span * 2; i++) {
        const lum = (data[i * 4] + data[i * 4 + 1] + data[i * 4 + 2]) / 3;
        ink += (1 - lum / 255) * (data[i * 4 + 3] / 255);
      }
      return ink / scale;
    },
    { clientX, clientY, window },
  );
}

/** One HTTP request over the app's Unix socket. */
export function sock<T = any>(socketPath: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      { socketPath, method, path, headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {} },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : undefined });
        });
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

/**
 * Playwright's pinned headless Chromium when it is installed, else the newest
 * cached one, so tests never download a browser.
 */
export function chromiumExecutable(): string | undefined {
  const cache = join(process.env.HOME ?? '', 'Library/Caches/ms-playwright');
  if (!existsSync(cache)) return undefined;
  const shells = readdirSync(cache)
    .filter((d) => d.startsWith('chromium_headless_shell-'))
    .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  for (const dir of shells) {
    const exe = join(cache, dir, 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell');
    if (existsSync(exe)) return exe;
  }
  return undefined;
}
