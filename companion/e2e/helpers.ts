import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test';
import type { DeliveriesResponse, OpenResponse, Skeleton } from '../src/protocol';
import type { BoardBackend } from '../src/server/contract';
import type { Draft } from '../src/shared/ipc';

export const ROOT = resolve(import.meta.dirname, '..');
export const RESULTS = join(ROOT, 'test-results');
mkdirSync(RESULTS, { recursive: true });

export function tempDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'companion-e2e-'));
}

/** A login flow in a frame: shapes, bound arrows and a sticky. */
export const FLOW: Skeleton[] = [
  { type: 'frame', id: 'flow', label: 'Login flow' },
  { type: 'rectangle', id: 'start', x: 100, y: 100, label: 'Open the app', frameId: 'flow' },
  { type: 'diamond', id: 'check', x: 400, y: 90, label: 'Signed in?', frameId: 'flow' },
  { type: 'ellipse', id: 'done', x: 720, y: 95, label: 'Home', color: 'green', frameId: 'flow' },
  { type: 'arrow', id: 'a1', start: { id: 'start' }, end: { id: 'check' }, frameId: 'flow' },
  { type: 'arrow', id: 'a2', start: { id: 'check' }, end: { id: 'done' }, label: 'yes', frameId: 'flow' },
  { type: 'sticky', id: 'note', x: 400, y: 260, label: 'Remember SSO', frameId: 'flow' },
];

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
  await page.waitForFunction(() => !!window.__board?.api, undefined, { timeout: 30_000 });
  return { app, page };
}

/** Launches against a fresh data dir, shows the panel, and waits for the socket. */
export async function launchShown(): Promise<{ ctx: Launched; socketPath: string; dataDir: string }> {
  const dataDir = tempDataDir();
  const socketPath = join(dataDir, 'companion.sock');
  const ctx = await launch(dataDir);
  await showPanel(ctx.app, ctx.page);
  await expect.poll(() => existsSync(socketPath)).toBe(true);
  return { ctx, socketPath, dataDir };
}

/** Shows the panel through the same function the global shortcut calls. */
export async function showPanel(app: ElectronApplication, page?: Page): Promise<void> {
  await app.evaluate(() => {
    const c = globalThis.__companion;
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

/** Opens the board menu and runs New board from its foot. */
export async function boardMenu(page: Page, action: 'board-new'): Promise<void> {
  await page.getByTestId('board-picker').click();
  await page.getByTestId(action).click();
}

/** The sidebar row of the active container's board named `name`. */
export function boardRow(page: Page, name: string) {
  const exact = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
  return page.getByTestId('brief-children').locator('li', { has: page.getByTestId('brief-board').filter({ hasText: exact }) });
}

/** Opens a sidebar board's ⋯ menu. */
export async function boardRowMenu(page: Page, name: string): Promise<void> {
  const row = boardRow(page, name);
  await row.hover();
  await row.getByTestId('board-more').click();
  await page.getByTestId('board-row-menu').waitFor();
}

/** Renames a sidebar board from its ⋯ menu. */
export async function renameBoardRow(page: Page, from: string, to: string): Promise<void> {
  await boardRowMenu(page, from);
  await page.getByTestId('board-row-rename').click();
  await page.getByTestId('board-row-name').fill(to);
  await page.getByTestId('board-row-name').press('Enter');
}

/** Switches boards from the sidebar, or from the board menu while the sidebar is hidden. */
export async function pickBoard(page: Page, name: string): Promise<void> {
  const exact = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
  const listed = page.getByTestId('brief-children').getByTestId('brief-board').filter({ hasText: exact });
  if (await listed.count()) return listed.click();
  await page.getByTestId('board-picker').click();
  await page.getByTestId('board-item').filter({ hasText: exact }).click();
}

/** Opens Send's chooser and sends to the running session whose row shows `title`. */
export async function sendToSession(page: Page, title: string): Promise<void> {
  await page.getByTestId('send').click();
  await page.getByTestId('send-to-session').filter({ hasText: title }).click();
}

type BackendMethod = keyof BoardBackend;
type BackendCall<K extends BackendMethod> = NonNullable<BoardBackend[K]>;

/** A BoardBackend result after it crosses from main. Buffers arrive as base64. */
type Wire<T> = T extends Buffer ? { base64: string } : T;

/** Calls a BoardBackend method in the main process. */
export function backend<K extends BackendMethod>(
  app: ElectronApplication,
  method: K,
  ...args: Parameters<BackendCall<K>>
): Promise<Wire<Awaited<ReturnType<BackendCall<K>>>>> {
  return app.evaluate(
    async (_electron, { method, args }) => {
      const methods = globalThis.__companion.backend as Record<BackendMethod, (...a: unknown[]) => unknown>;
      const result = await methods[method](...args);
      return Buffer.isBuffer(result) ? { base64: result.toString('base64') } : result;
    },
    { method, args },
  ) as Promise<Wire<Awaited<ReturnType<BackendCall<K>>>>>;
}

/** Scene elements in the renderer, including deleted ones. */
export function sceneElements(page: Page) {
  return page.evaluate(() => window.__excalidraw.getSceneElementsIncludingDeleted());
}

/** Waits until the board view stops moving, so screen points map to the scene it settles on. */
export async function settled(page: Page): Promise<void> {
  const view = () =>
    page.evaluate(() => {
      const s = window.__excalidraw.getAppState();
      return `${s.scrollX},${s.scrollY},${s.zoom.value}`;
    });
  let last = '';
  await expect
    .poll(async () => {
      const now = await view();
      const still = now === last;
      last = now;
      return still;
    }, { intervals: [150] })
    .toBe(true);
}

/** The canvas Excalidraw draws on and takes input from. */
export function interactiveCanvas(page: Page) {
  return page.locator('canvas.excalidraw__canvas.interactive');
}

/** Picks the pen, as the person would before drawing. The board opens on the pointer. */
export async function pickPen(page: Page): Promise<void> {
  await page.evaluate(() => window.__excalidraw.setActiveTool({ type: 'freedraw' }));
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
      const proto: Element & { __captureWrapped?: boolean } = Element.prototype;
      if (!proto.__captureWrapped) {
        const original = proto.setPointerCapture;
        proto.setPointerCapture = function (this: Element, id: number) {
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
export function sock<T = unknown>(socketPath: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
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

/** The selected draft's Markdown body, as the renderer holds it. */
export function draftBody(page: Page): Promise<string> {
  return page.evaluate(() => window.__drafts.selected?.body ?? '');
}

/** The text the person has selected in the page. */
export function selectedText(page: Page): Promise<string> {
  return page.evaluate(() => window.getSelection()?.toString() ?? '');
}

/**
 * Types into the draft editor, replacing what it held. Real keys, so
 * Markdown input rules fire. A newline in `text` presses Enter.
 */
export async function typeDraft(page: Page, text: string): Promise<void> {
  const body = page.getByTestId('draft-body');
  await body.click();
  await page.keyboard.press('Meta+A');
  await page.keyboard.press('Backspace');
  await page.keyboard.type(text);
}

/** A new project folder named `name`, for a session to run in. */
export function projectDir(name: string): string {
  return join(mkdtempSync(join(tmpdir(), 'project-')), name);
}

/** Registers a session over the socket, as the plugin does. */
export function registerSession(socketPath: string, sessionId: string, title: string, cwd = projectDir(title)) {
  return sock(socketPath, 'POST', '/sessions', { sessionId, cwd, title });
}

/** Asks the app to open the panel, as /sketch and /write do. */
export async function openPanelFor(socketPath: string, body: Record<string, unknown>) {
  return (await sock<OpenResponse>(socketPath, 'POST', '/open', body)).body;
}

/** A session's deliveries waiting now. */
export async function deliveriesFor(socketPath: string, sessionId: string) {
  return (await sock<DeliveriesResponse>(socketPath, 'GET', `/deliveries?session=${sessionId}&wait=0`)).body.deliveries;
}

/** The drafts saved in `dataDir`. */
export function draftsOnDisk(dataDir: string): Draft[] {
  const dir = join(dataDir, 'drafts');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')));
}

/** The session tab whose title holds `title`. */
export function briefTab(page: Page, title: string) {
  return page.getByTestId('brief-tab').filter({ hasText: title });
}

/** Unfolds the sidebar's Ended group, where ended sessions wait. */
export async function showEnded(page: Page): Promise<void> {
  const toggle = page.getByTestId('ended-toggle');
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
}

/** Saves `<name>-light.png` and `<name>-dark.png` when UI_SHOTS names a folder. */
export async function themeShots(ctx: Launched, name: string, clip?: { x: number; y: number; width: number; height: number }): Promise<void> {
  const dir = process.env.UI_SHOTS;
  if (!dir) return;
  for (const theme of ['light', 'dark'] as const) {
    await ctx.app.evaluate(({ nativeTheme }, t) => (nativeTheme.themeSource = t), theme);
    await ctx.page.waitForTimeout(250);
    await ctx.page.screenshot({ path: join(dir, `${name}-${theme}.png`), ...(clip ? { clip } : {}) });
  }
}
