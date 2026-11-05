import { chromium, expect, test, type Browser, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PEN_RANGE_MS } from '../src/renderer/pen';
import { chromiumExecutable } from './helpers';

/** The iPad's board page, in a browser, with synthetic finger and Pencil input. */

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(HERE, '../ios/AgentBrief/Web');
const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' };
const BASE = { type: 'excalidraw', version: 2, elements: [{ id: 'base1', type: 'rectangle', x: 300, y: 300, width: 200, height: 120, version: 1, versionNonce: 1, angle: 0, strokeColor: '#1971c2', backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'solid', roughness: 1, opacity: 100, groupIds: [], frameId: null, roundness: null, seed: 1, isDeleted: false, boundElements: null, updated: 1, link: null, locked: false, index: 'a0' }], appState: {}, files: {} };

let server: Server;
let browser: Browser;
let url: string;

test.beforeAll(async () => {
  execFileSync('pnpm', ['exec', 'vite', 'build', '--config', 'vite.ipad.config.ts'], { cwd: resolve(HERE, '..'), stdio: 'ignore' });
  server = createServer((req, res) => {
    const path = join(WEB, req.url === '/' ? 'index.html' : (req.url ?? '').split('?')[0]);
    if (!path.startsWith(WEB) || !existsSync(path)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[extname(path)] ?? 'application/octet-stream' });
    createReadStream(path).pipe(res);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  browser = await chromium.launch({ executablePath: chromiumExecutable() });
});

test.afterAll(async () => {
  await browser?.close();
  server?.close();
});

async function openBoard(comments: string | null = null): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  // Synthetic pointers have no real capture to take, and the call would throw.
  await page.addInitScript(() => {
    Element.prototype.setPointerCapture = () => {};
    Element.prototype.releasePointerCapture = () => {};
  });
  await page.goto(url);
  await page.waitForFunction(() => (window as any).__ipad);
  await page.evaluate(async ([scene, saved]) => {
    await (window as any).__ipad.open({ boardName: 'h1', scene, notes: '', comments: saved });
  }, [JSON.stringify(BASE), comments] as const);
  return page;
}

/** Dispatches one pointer event on the interactive canvas. */
const pointer = (page: Page, type: string, pointerType: string, pointerId: number, x: number, y: number) =>
  page.evaluate(([t, kind, id, cx, cy]) => {
    const canvas = document.querySelector('canvas.interactive')!;
    canvas.dispatchEvent(new PointerEvent(t as string, { pointerType: kind as string, pointerId: id as number, clientX: cx as number, clientY: cy as number, button: t === 'pointermove' ? -1 : 0, buttons: t === 'pointerup' ? 0 : 1, bubbles: true, cancelable: true, isPrimary: id === 1 }));
  }, [type, pointerType, pointerId, x, y] as const);

const tap = async (page: Page, kind: string, id: number, x: number, y: number) => {
  await pointer(page, 'pointerdown', kind, id, x, y);
  await pointer(page, 'pointerup', kind, id, x, y);
};

const pinch = async (page: Page) => {
  await pointer(page, 'pointerdown', 'touch', 11, 500, 400);
  await pointer(page, 'pointerdown', 'touch', 12, 600, 400);
  for (let spread = 10; spread <= 100; spread += 10) {
    await pointer(page, 'pointermove', 'touch', 11, 500 - spread, 400);
    await pointer(page, 'pointermove', 'touch', 12, 600 + spread, 400);
  }
  await pointer(page, 'pointerup', 'touch', 11, 400, 400);
  await pointer(page, 'pointerup', 'touch', 12, 700, 400);
};

const zoom = (page: Page) => page.locator('.excalidraw .reset-zoom-button').innerText();
const collect = (page: Page) => page.evaluate(async () => JSON.parse(await (window as any).__ipad.collect([], 'h1')));
const drawing = (page: Page) => page.locator('.excalidraw input[data-testid="toolbar-freedraw"]');

test('a pinch zooms after an Apple Pencil has turned on pen mode, and the pen tool comes back', async () => {
  const page = await openBoard();
  // A Pencil lift with no pointerout, then the wait palm rejection asks for.
  await tap(page, 'pen', 21, 200, 200);
  await page.waitForTimeout(PEN_RANGE_MS + 100);
  expect(await zoom(page)).toBe('100%');
  await pinch(page);
  await expect.poll(() => zoom(page)).not.toBe('100%');
  await expect(drawing(page)).toBeChecked();
  await page.close();
});

test('comments pin on a tap, not on a pinch, take words, and go out with the delivery', async () => {
  const page = await openBoard();
  const cards = page.getByTestId('board-comment-card');
  await expect(page.getByTestId('board-comments')).toHaveCount(0);

  await page.evaluate(() => (window as any).__ipad.setCommenting(true));
  await expect(page.getByTestId('board-comments')).toBeVisible();

  // A pinch or a drag moves the view and leaves no pin.
  await pinch(page);
  await expect.poll(() => zoom(page)).not.toBe('100%');
  await expect(cards).toHaveCount(0);

  await tap(page, 'touch', 31, 500, 300);
  await expect(cards).toHaveCount(1);
  await cards.locator('textarea').fill('Make this bigger');
  await page.screenshot({ path: join(HERE, '../test-results/ipad-comment-column.png') });

  // Words go to the comment selected when they began.
  const at = Date.now() + 1;
  const took = await page.evaluate(([t]) => (window as any).__ipad.heard('and darker', t), [at] as const);
  expect(took).toBe(true);
  await expect(cards.locator('textarea')).toHaveValue('Make this bigger and darker');

  const delivery = await collect(page);
  expect(delivery.comments.pins).toHaveLength(1);
  expect(delivery.comments.pins[0].text).toBe('Make this bigger and darker');

  // A later press draws again once the tool is off.
  await page.evaluate(() => (window as any).__ipad.setCommenting(false));
  await expect(drawing(page)).toBeChecked();
  await page.close();
});

test('with no comments, speech stays in the timeline', async () => {
  const page = await openBoard();
  expect(await page.evaluate(() => (window as any).__ipad.heard('just talking', 1))).toBe(false);
  expect((await collect(page)).comments).toBeUndefined();
  await page.close();
});

test('saved comments come back when the board opens', async () => {
  const saved = JSON.stringify({ overall: 'Keep it simple', pins: [{ id: 'p1', x: 400, y: 350, text: 'Still here', createdAt: 1 }] });
  const page = await openBoard(saved);
  await expect(page.getByTestId('board-comment-card').locator('textarea')).toHaveValue('Still here');
  await expect(page.getByTestId('board-overall')).toHaveValue('Keep it simple');
  await page.close();
});
