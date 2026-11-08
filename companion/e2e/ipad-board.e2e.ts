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

async function openBoard(comments: string | null = null, viewport = { width: 1100, height: 800 }, notes = '', scene: object = BASE): Promise<Page> {
  const page = await browser.newPage({ viewport });
  // Synthetic pointers have no real capture to take, and the call would throw.
  await page.addInitScript(() => {
    Element.prototype.setPointerCapture = () => {};
    Element.prototype.releasePointerCapture = () => {};
  });
  await page.goto(url);
  await page.waitForFunction(() => (window as any).__ipad);
  await page.evaluate(async ([json, saved, note]) => {
    await (window as any).__ipad.open({ boardName: 'h1', scene: json, notes: note, comments: saved });
  }, [JSON.stringify(scene), comments, notes] as const);
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

/** A Stack board as the Mac saves it after Claude adds pictures while it is hidden, before its layout runs. */
async function unlaidStack(page: Page): Promise<object> {
  const dataURL = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 400;
    c.height = 300;
    const g = c.getContext('2d')!;
    g.fillStyle = '#3b82f6';
    g.fillRect(0, 0, 400, 300);
    return c.toDataURL('image/png');
  });
  const el = { ...BASE.elements[0], strokeColor: 'transparent' };
  const frame = { ...el, id: 'g1', type: 'frame', x: 0, y: 0, width: 880, height: 360, name: '1', customData: { stack: { index: 1 } }, index: 'a0' };
  const image = (id: string, x: number, index: string) => ({ ...el, id, type: 'image', x, y: 30, width: 400, height: 300, fileId: `f-${id}`, status: 'saved', scale: [1, 1], frameId: 'g1', index });
  const file = (id: string) => ({ id: `f-${id}`, mimeType: 'image/png', dataURL, created: 1 });
  return { type: 'excalidraw', version: 2, elements: [frame, image('a', 20, 'a1'), image('b', 460, 'a2')], appState: {}, files: { 'f-a': file('a'), 'f-b': file('b') }, agentBrief: { layout: 'stack' } };
}

/** How many pixels of the static canvas show the pictures' blue. */
const bluePixels = (page: Page) =>
  page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('canvas.excalidraw__canvas.static')!;
    const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
    let blue = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i] === 59 && data[i + 1] === 130 && data[i + 2] === 246) blue++;
    return blue;
  });

test('a Stack board shows its pictures when its layout runs on open', async () => {
  const blank = await browser.newPage();
  await blank.goto(url);
  const scene = await unlaidStack(blank);
  await blank.close();
  const page = await openBoard(null, undefined, '', scene);
  await expect.poll(() => bluePixels(page), { timeout: 5000 }).toBeGreaterThan(10_000);
  await page.close();
});

/** Long enough for a resize to reach Excalidraw, a refit to run, and the canvas to redraw. */
const REDRAW_MS = 600;

/** The box, in page pixels, of the static canvas's blue picture pixels. Top is Infinity when none show. */
const blueBox = (page: Page) =>
  page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('canvas.excalidraw__canvas.static')!;
    const rect = canvas.getBoundingClientRect();
    const ratio = canvas.width / rect.width;
    const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
    let top = Infinity, bottom = -Infinity;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] !== 59 || data[i + 1] !== 130 || data[i + 2] !== 246) continue;
      const y = Math.floor(i / 4 / canvas.width) / ratio + rect.top;
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
    return { top, bottom, canvasTop: rect.top, canvasBottom: rect.bottom };
  });

test('on a narrow screen the first board fits above the docked panel', async () => {
  const blank = await browser.newPage();
  await blank.goto(url);
  const scene = await unlaidStack(blank);
  await blank.close();
  const page = await openBoard(null, { width: 466, height: 678 }, '', scene);
  await expect(page.getByTestId('ipad-panel')).toBeVisible();
  await expect.poll(async () => {
    const box = await blueBox(page);
    return Number.isFinite(box.top) && box.top >= box.canvasTop && box.bottom <= box.canvasBottom;
  }, { timeout: 5000 }).toBe(true);
  await page.close();
});

test('the board fits again when its view changes size just after it opens, until a touch', async () => {
  const blank = await browser.newPage();
  await blank.goto(url);
  const scene = await unlaidStack(blank);
  await blank.close();
  const inView = async (page: Page) => {
    const box = await blueBox(page);
    return Number.isFinite(box.top) && box.top >= box.canvasTop && box.bottom <= box.canvasBottom;
  };

  // The native view settles to a shorter size after the board opens.
  const page = await openBoard(null, { width: 466, height: 1100 }, '', scene);
  await expect.poll(() => inView(page)).toBe(true);
  // The canvas keeps its old picture for a moment after a resize.
  await page.setViewportSize({ width: 466, height: 520 });
  await page.waitForTimeout(REDRAW_MS);
  expect(await inView(page)).toBe(true);

  // After a touch, a resize leaves the view where the person put it.
  const before = await blueBox(page);
  await tap(page, 'touch', 31, 40, 300);
  await page.setViewportSize({ width: 466, height: 900 });
  await page.waitForTimeout(REDRAW_MS);
  expect((await blueBox(page)).top).toBe(before.top);
  await page.close();
});

test("the toolbar's Undo and Redo press the board's hidden buttons and follow their state", async () => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  await page.addInitScript(() => {
    Element.prototype.setPointerCapture = () => {};
    Element.prototype.releasePointerCapture = () => {};
    (window as any).__history = [];
    (window as any).webkit = { messageHandlers: { agentBrief: { postMessage: (m: any) => m.type === 'history' && (window as any).__history.push(m) } } };
  });
  await page.goto(url);
  await page.waitForFunction(() => (window as any).__ipad);
  await page.evaluate(async (scene) => (window as any).__ipad.open({ boardName: 'h1', scene, notes: '', comments: null }), JSON.stringify(BASE));
  const last = () => page.evaluate(() => (window as any).__history.at(-1));
  const strokes = async () => (await collect(page)).scene.elements.filter((e: { type: string; isDeleted?: boolean }) => e.type === 'freedraw' && !e.isDeleted).length;
  const shown = () => page.locator('.excalidraw [data-testid^="button-"]:is([data-testid$="undo"], [data-testid$="redo"]):visible').count();
  expect(await shown()).toBe(0);
  await expect.poll(last).toEqual({ type: 'history', undo: false, redo: false });

  await pointer(page, 'pointerdown', 'pen', 21, 200, 200);
  for (let x = 210; x <= 400; x += 20) await pointer(page, 'pointermove', 'pen', 21, x, 220);
  await pointer(page, 'pointerup', 'pen', 21, 400, 220);
  await expect.poll(strokes).toBe(1);
  await expect.poll(last).toEqual({ type: 'history', undo: true, redo: false });

  await page.evaluate(() => (window as any).__ipad.undo());
  await expect.poll(strokes).toBe(0);
  await expect.poll(last).toEqual({ type: 'history', undo: false, redo: true });

  await page.evaluate(() => (window as any).__ipad.redo());
  await expect.poll(strokes).toBe(1);
  await expect.poll(last).toEqual({ type: 'history', undo: true, redo: false });

  // A phone's narrow layout draws its own undo and redo, which stay hidden and still work.
  await page.setViewportSize({ width: 466, height: 678 });
  await expect(page.locator('.excalidraw--mobile')).toHaveCount(1);
  expect(await shown()).toBe(0);
  await page.evaluate(() => (window as any).__ipad.undo());
  await expect.poll(strokes).toBe(0);
  await page.close();
});

test('comments pin on a tap, not on a pinch, take words, and go out with the delivery', async () => {
  const page = await openBoard();
  const cards = page.getByTestId('board-comment-card');
  await expect(page.getByTestId('board-comments')).toBeVisible();
  await expect(page.getByTestId('pin-toggle')).toHaveAttribute('aria-pressed', 'false');

  await page.evaluate(() => (window as any).__ipad.setCommenting(true));
  await expect(page.getByTestId('pin-toggle')).toHaveAttribute('aria-pressed', 'true');

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
  // Nothing is selected, so the overall note is open and the pin folds to a line.
  await expect(page.getByTestId('board-comment-card')).toContainText('Still here');
  await expect(page.getByTestId('board-overall')).toHaveValue('Keep it simple');
  await page.close();
});

const heard = (page: Page, text: string, t: number, words?: { text: string; atMs: number }[]) =>
  page.evaluate(([x, at, w]) => (window as any).__ipad.heard(x, at, w), [text, t, words] as const);
const live = (page: Page, text: string, t: number, words?: { text: string; atMs: number }[]) =>
  page.evaluate(([x, at, w]) => (window as any).__ipad.live(x, at, w), [text, t, words] as const);
const now = (page: Page) => page.evaluate(() => Date.now());

test('words follow a tap made in the middle of a phrase', async () => {
  const page = await openBoard();
  await page.evaluate(() => (window as any).__ipad.setCommenting(true));
  const cards = page.getByTestId('board-comment-card');

  await tap(page, 'touch', 31, 300, 300);
  await expect(cards).toHaveCount(1);
  const first = await now(page);
  await page.waitForTimeout(30);
  await tap(page, 'touch', 32, 500, 500);
  await expect(cards).toHaveCount(2);
  const second = await now(page);

  // One phrase, no pause, with the second tap between its words.
  const words = [
    { text: 'make', atMs: first + 5 },
    { text: 'it', atMs: first + 10 },
    { text: 'red,', atMs: second + 5 },
    { text: 'this', atMs: second + 10 },
  ];
  expect(await heard(page, 'make it red, this', first + 5, words)).toBe(true);
  const pins = (await collect(page)).comments.pins;
  expect(pins.map((p: { text: string }) => p.text)).toEqual(['make it', 'red, this']);
  await page.close();
});

test('words show in the selected comment while they settle', async () => {
  const page = await openBoard();
  await page.evaluate(() => (window as any).__ipad.setCommenting(true));
  await page.evaluate(() => (window as any).__ipad.setListening(true));
  await tap(page, 'touch', 31, 400, 300);
  const card = page.locator('.review-card.active');
  await expect(card).toHaveCount(1);

  const t = await now(page);
  expect(await live(page, 'make the', t, [{ text: 'make', atMs: t }, { text: 'the', atMs: t + 5 }])).toBe(true);
  await expect(card.getByTestId('review-voice-settling')).toHaveText('make the');
  await page.screenshot({ path: join(HERE, '../test-results/ipad-settling.png') });

  expect(await heard(page, 'make the header blue', t, [{ text: 'make', atMs: t }])).toBe(true);
  await expect(card.getByTestId('review-voice-settling')).toHaveCount(0);
  await expect(card.locator('textarea')).toHaveValue('make the header blue');
  await page.close();
});

test('with no comments, settling words stay out of the panel', async () => {
  const page = await openBoard();
  expect(await live(page, 'just talking', 1)).toBe(false);
  await expect(page.getByTestId('review-voice-settling')).toHaveCount(0);
  await page.close();
});

test('the note lives in the panel and goes out with the delivery', async () => {
  const page = await openBoard(null, undefined, 'From the Mac');
  await page.getByTestId('panel-note-tab').click();
  const note = page.getByTestId('note-editor');
  await expect(note).toHaveValue('From the Mac');
  await note.fill('Use the blue from the logo');
  expect((await collect(page)).notes).toBe('Use the blue from the logo');
  await page.close();
});

test('hiding the panel turns the pin tool off', async () => {
  const page = await openBoard();
  await page.evaluate(() => (window as any).__ipad.setCommenting(true));
  await page.evaluate(() => (window as any).__ipad.setPanel(false));
  await expect(page.getByTestId('ipad-panel')).toHaveCount(0);
  await expect(drawing(page)).toBeChecked();
  await page.close();
});

const box = async (page: Page, testId: string) => (await page.getByTestId(testId).boundingBox())!;

test('a narrow screen docks the panel under the board and folds other comments to a line', async () => {
  const saved = JSON.stringify({ overall: '', pins: [{ id: 'p1', x: 400, y: 350, text: 'Move the header up', createdAt: 1 }, { id: 'p2', x: 300, y: 320, text: 'Darker', createdAt: 2 }] });
  // The iPhone Duo's outer screen.
  const page = await openBoard(saved, { width: 466, height: 678 });
  const panel = await box(page, 'ipad-panel');
  const canvas = await box(page, 'canvas');
  expect(panel.y).toBeGreaterThanOrEqual(canvas.y + canvas.height - 1);
  expect(panel.width).toBeGreaterThan(460);
  expect(panel.height).toBeLessThanOrEqual(678 * 0.38 + 1);

  await page.getByTestId('board-comment-card').first().getByRole('button').click();
  await expect(page.locator('.review-card.active textarea')).toHaveValue('Move the header up');
  await expect(page.locator('.review-card.folded')).toHaveCount(1);
  await expect(page.getByTestId('board-overall-folded')).toBeVisible();
  await page.screenshot({ path: join(HERE, '../test-results/ipad-duo-outer.png') });

  // The last comment, once picked, scrolls into the short panel with its words.
  await page.getByTestId('board-comment-card').last().getByRole('button').click();
  const active = (await page.locator('.review-card.active').boundingBox())!;
  const shown = await box(page, 'ipad-panel');
  expect(active.y + active.height).toBeLessThanOrEqual(shown.y + shown.height + 1);

  await page.close();
});

test('an upright fold puts the panel on the far side of it', async () => {
  // The iPhone Duo's inner screen, partly folded like a book.
  const page = await openBoard(null, { width: 626, height: 890 });
  await page.evaluate(() => (window as any).__ipad.setFold({ x: 312, y: 0, width: 2, height: 890 }));
  const panel = await box(page, 'ipad-panel');
  expect(Math.round(panel.x)).toBe(314);
  expect(Math.round(panel.width)).toBe(312);
  await page.screenshot({ path: join(HERE, '../test-results/ipad-duo-book.png') });

  // Laid flat again, a screen this narrow docks the panel under the board.
  await page.evaluate(() => (window as any).__ipad.setFold(undefined));
  await expect.poll(async () => (await box(page, 'ipad-panel')).width).toBeGreaterThan(620);
  await page.screenshot({ path: join(HERE, '../test-results/ipad-duo-inner.png') });
  await page.close();
});

test('a flat fold puts the panel under it', async () => {
  // Tabletop: the board above the fold, the panel below.
  const page = await openBoard(null, { width: 890, height: 626 });
  await page.evaluate(() => (window as any).__ipad.setFold({ x: 0, y: 312, width: 890, height: 2 }));
  const panel = await box(page, 'ipad-panel');
  expect(Math.round(panel.y)).toBe(314);
  expect(Math.round(panel.width)).toBe(890);
  await page.close();
});
