import { chromium, devices, expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DeliveriesResponse } from '../src/protocol';
import type { IpadStatus } from '../src/shared/ipc';
import { RESULTS, ROOT, chromiumExecutable, launch, sceneElements, showPanel, sock, tempDataDir, type Launched } from './helpers';

/** An 11-inch iPad in landscape, as the spec asks for screenshots. */
const SPEECH = join(ROOT, 'e2e/fixtures/speech.wav');

const IPAD = { ...devices['iPad Pro 11 landscape'], viewport: { width: 1180, height: 820 } };

let mac: Launched;
let dataDir: string;
let socketPath: string;
let browser: Browser;
const contexts: BrowserContext[] = [];

test.beforeAll(async () => {
  // The pinned browser if present, else the newest cached headless shell.
  try {
    browser = await chromium.launch();
  } catch {
    browser = await chromium.launch({ executablePath: chromiumExecutable() });
  }
});

test.afterAll(async () => {
  await browser.close();
});

test.beforeEach(async () => {
  dataDir = tempDataDir();
  socketPath = join(dataDir, 'companion.sock');
  // The fake mic is ready for the voice test; the others never record.
  mac = await launch(dataDir, existsSync(SPEECH) ? { COMPANION_TEST_AUDIO: SPEECH } : {});
  await showPanel(mac.app, mac.page);
  await expect.poll(() => existsSync(socketPath)).toBe(true);
});

test.afterEach(async () => {
  for (const c of contexts.splice(0)) await c.close();
  await mac.app.close();
});

const openIpad = (): Promise<IpadStatus> => mac.app.evaluate(async () => {
  const c = (globalThis as any).__companion;
  await c.openIpad();
  return c.ipad.current();
});

/** A new iPad-sized browser that pairs with a fresh code and waits for the board. */
async function pairedPage(): Promise<Page> {
  const { url } = await openIpad();
  const context = await browser.newContext({ ...IPAD });
  contexts.push(context);
  const page = await context.newPage();
  await page.goto(url!);
  await page.waitForFunction(() => !!(window as any).__board?.api, undefined, { timeout: 20_000 });
  return page;
}

const liveIds = async (page: Page) =>
  (await sceneElements(page)).filter((e) => !e.isDeleted).map((e) => e.id as string);

async function stroke(page: Page, y: number, from = 200, to = 500) {
  const box = (await page.locator('canvas.excalidraw__canvas.interactive').boundingBox())!;
  await page.mouse.move(box.x + from, box.y + y);
  await page.mouse.down();
  for (let x = from; x <= to; x += 30) await page.mouse.move(box.x + x, box.y + y + (x % 60 === 0 ? 4 : 0));
  await page.mouse.up();
}

test('pairing: no cookie gets 401, a code works once, and revoking disconnects', async () => {
  const { url, firstRun } = await openIpad();
  expect(firstRun).toBe(true);
  const origin = new URL(url!).origin;
  await expect(mac.page.getByTestId('ipad-sheet')).toBeVisible();
  await expect(mac.page.getByTestId('ipad-url')).toHaveText(url!);
  await expect(mac.page.getByTestId('ipad-firewall')).toBeVisible();

  const stranger = await browser.newContext();
  contexts.push(stranger);
  expect((await stranger.request.get(`${origin}/`)).status()).toBe(401);
  expect((await stranger.request.get(`${origin}/api/boards`)).status()).toBe(401);

  const ipadContext = await browser.newContext({ ...IPAD });
  contexts.push(ipadContext);
  const ipad = await ipadContext.newPage();
  await ipad.goto(url!);
  await ipad.waitForFunction(() => !!(window as any).__board?.api);
  expect(new URL(ipad.url()).search).toBe('');
  expect((await ipadContext.request.get(`${origin}/api/boards`)).status()).toBe(200);

  // The same code a second time is refused.
  const late = await browser.newContext();
  contexts.push(late);
  expect((await late.request.get(url!, { maxRedirects: 0 })).status()).toBe(401);

  await expect(mac.page.getByTestId('ipad-devices').locator('li')).toHaveCount(1);
  await expect(mac.page.getByTestId('ipad-devices')).toContainText('iPad');
  await mac.page.screenshot({ path: join(RESULTS, 'ipad-pairing-sheet.png') });

  const [device] = (await openIpad()).devices;
  await mac.page.getByTestId(`ipad-revoke-${device.id}`).click();
  await expect(ipad.getByTestId('notice')).toHaveText(/not paired/);
  expect((await ipadContext.request.get(`${origin}/api/boards`)).status()).toBe(401);
});

test('C6.2 a stroke reaches the other clients within 500 ms, and concurrent edits both survive', async () => {
  const a = await pairedPage();
  const b = await pairedPage();
  const before = new Set(await liveIds(b));

  // Strokes stream while drawn. Time from pen-up until the other iPad has the finished stroke.
  await stroke(a, 200, 400, 700);
  const liftedAt = Date.now();
  const done = await a.evaluate(() => {
    const e = (window as any).__excalidraw.getSceneElements().find((x: any) => x.type === 'freedraw');
    return { id: e.id, points: e.points.length };
  });
  await b.waitForFunction(
    ({ id, points }) => (window as any).__excalidraw.getSceneElements().some((e: any) => e.id === id && e.points.length === points),
    done,
    { timeout: 2000, polling: 5 },
  );
  const latency = Date.now() - liftedAt;
  console.log(`[C6.2] finished stroke (${done.points} points) reached the second iPad ${latency} ms after pen-up`);
  expect(before.has(done.id)).toBe(false);
  expect(latency).toBeLessThan(500);
  await expect.poll(() => liveIds(mac.page)).toHaveLength(1);

  // Two people draw at the same moment on different parts of the board.
  // Strokes start right of the tool panel Excalidraw shows on the left.
  await Promise.all([stroke(a, 330, 400, 600), stroke(b, 460, 650, 900)]);
  for (const page of [a, b, mac.page]) {
    await expect.poll(async () => (await sceneElements(page)).filter((e) => !e.isDeleted && e.type === 'freedraw').length).toBe(3);
  }
  const ids = (await liveIds(mac.page)).sort();
  expect((await liveIds(a)).sort()).toEqual(ids);
  expect((await liveIds(b)).sort()).toEqual(ids);

  // The Mac saves what the iPads drew.
  await expect
    .poll(() => {
      const file = JSON.parse(readFileSync(join(dataDir, 'boards', 'scratch.excalidraw'), 'utf8'));
      return file.elements.filter((e: any) => !e.isDeleted).length;
    })
    .toBe(3);
});

test('the iPad opens the board the Mac shows', async () => {
  await mac.app.evaluate(async () => (globalThis as any).__companion.backend.open({ board: 'plans' }));
  const ipad = await pairedPage();
  await expect(ipad.getByTestId('board-picker')).toHaveValue('plans');
});

test('C6.3 Claude drawing with the CLI shows on the iPad', async () => {
  const ipad = await pairedPage();
  const input = JSON.stringify({
    elements: [
      { id: 'idea', type: 'sticky', x: 0, y: 0, label: 'From Claude' },
      { id: 'next', type: 'rectangle', x: 300, y: 20, label: 'Next step', color: 'blue' },
      { type: 'arrow', start: { id: 'idea' }, end: { id: 'next' } },
    ],
  });
  await new Promise<void>((resolve, reject) => {
    const child = execFile('node', [join(ROOT, 'bin/agent-brief.mjs'), 'draw'], { env: { ...process.env, COMPANION_SOCKET: socketPath } }, (err) =>
      err ? reject(err) : resolve(),
    );
    child.stdin!.end(input);
  });
  await expect.poll(() => liveIds(ipad), { timeout: 3000 }).toEqual(expect.arrayContaining(['idea', 'next']));
  const sticky = (await sceneElements(ipad)).find((e) => e.id === 'idea');
  expect(sticky.customData.by).toBe('claude');
  await ipad.evaluate(() => (window as any).__excalidraw.scrollToContent(undefined, { fitToViewport: true, viewportZoomFactor: 0.7 }));
  await stroke(ipad, 520, 150, 600);
  await ipad.waitForTimeout(300);
  await ipad.screenshot({ path: join(RESULTS, 'ipad-web.png') });
});

test('C6.4 Send on the iPad delivers to the Mac\'s target session', async () => {
  const a = mkdtempSync(join(tmpdir(), 'project-'));
  const b = mkdtempSync(join(tmpdir(), 'project-'));
  await sock(socketPath, 'POST', '/sessions', { sessionId: 'sa', cwd: a, title: 'Alpha' });
  await sock(socketPath, 'POST', '/sessions', { sessionId: 'sb', cwd: b, title: 'Beta' });
  await sock(socketPath, 'POST', '/open', { sessionId: 'sb' });
  await expect.poll(async () => (await sock(socketPath, 'GET', '/sessions')).body.targetSessionId).toBe('sb');

  const ipad = await pairedPage();
  await expect(ipad.getByTestId('voice-note')).toHaveText('Voice records on the Mac');
  await expect(ipad.getByTestId('mic')).toHaveCount(0);
  await stroke(ipad, 300);
  await ipad.getByTestId('send').click();
  await expect(ipad.getByTestId('send-status')).toHaveText('Sent to Beta');

  expect(existsSync(join(a, '.feedback'))).toBe(false);
  // The sent sketch clears from both screens.
  const live = (page: typeof ipad) => page.evaluate(() => (window as any).__excalidraw.getSceneElements().length);
  await expect.poll(() => live(ipad)).toBe(0);
  await expect.poll(() => live(mac.page)).toBe(0);
  const [id] = readdirSync(join(b, '.feedback', 'sketches'));
  expect(readdirSync(join(b, '.feedback', 'sketches', id))).toEqual(expect.arrayContaining(['sketch.png', 'board.excalidraw']));
  const polled = await sock<DeliveriesResponse>(socketPath, 'GET', '/deliveries?session=sb&wait=0');
  expect(polled.body.deliveries.map((d) => d.id)).toEqual([id]);
  expect((await sock<DeliveriesResponse>(socketPath, 'GET', '/deliveries?session=sa&wait=0')).body.deliveries).toEqual([]);
});

test('Stop closes the iPad server and the page loses its connection', async () => {
  const ipad = await pairedPage();
  const { port } = await openIpad();
  await mac.page.getByTestId('ipad-stop').click();
  await expect(mac.page.getByTestId('ipad-start')).toBeVisible();
  await expect(ipad.getByTestId('target')).toHaveText('Reconnecting to the Mac…');
  await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
});

test('an Apple Pencil touch turns on Excalidraw pen mode on the iPad', async () => {
  const ipad = await pairedPage();
  expect(await ipad.evaluate(() => (window as any).__excalidraw.getAppState().penMode)).toBe(false);
  const cdp = await ipad.context().newCDPSession(ipad);
  const box = (await ipad.locator('canvas.excalidraw__canvas.interactive').boundingBox())!;
  const at = { x: box.x + 500, y: box.y + 300 };
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...at, button: 'left', buttons: 1, clickCount: 1, pointerType: 'pen', force: 0.6 } as never);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x + 80, y: at.y, button: 'left', buttons: 1, pointerType: 'pen', force: 0.6 } as never);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x + 80, y: at.y, button: 'left', buttons: 0, pointerType: 'pen' } as never);
  await expect.poll(() => ipad.evaluate(() => (window as any).__excalidraw.getAppState().penMode)).toBe(true);
});

test('Send on the iPad is refused until a session is chosen on the Mac', async () => {
  await sock(socketPath, 'POST', '/sessions', { sessionId: 'sa', cwd: mkdtempSync(join(tmpdir(), 'project-')), title: 'Alpha' });
  const ipad = await pairedPage();
  await expect(ipad.getByTestId('target')).toHaveText('Sends to the session chosen on the Mac');
  await stroke(ipad, 300);
  await ipad.getByTestId('send').click();
  await expect(ipad.getByTestId('send-status')).toContainText('Choose a Claude Code session on the Mac first.');
});

test('a Send from the iPad carries the Mac\'s voice and the timeline of the iPad strokes', async () => {
  test.skip(!existsSync(SPEECH), 'speech fixture missing');
  test.setTimeout(120_000);
  const cwd = mkdtempSync(join(tmpdir(), 'project-'));
  await sock(socketPath, 'POST', '/sessions', { sessionId: 'v1', cwd, title: 'Pricing' });
  await sock(socketPath, 'POST', '/open', { sessionId: 'v1' });
  const ipad = await pairedPage();

  // Recording starts on the Mac, then the panel goes away while the user works on the iPad.
  await mac.page.getByTestId('ipad-close').click();
  await mac.page.getByTestId('mic').click();
  await expect(mac.page.getByTestId('mic')).toHaveText('● 00:00');
  await mac.app.evaluate(() => (globalThis as any).__companion.panel.hide());

  await stroke(ipad, 250, 400, 800);
  await ipad.waitForTimeout(1500);
  await stroke(ipad, 450, 400, 800);
  await ipad.waitForTimeout(2500);
  const logged = await mac.page.evaluate(() => (window as any).__board.strokes.events.map((e: any) => `${e.kind}:${e.by}:${e.source}`));
  expect(logged).toEqual(['add:user:ipad', 'add:user:ipad']);

  await ipad.getByTestId('send').click();
  await expect(ipad.getByTestId('send-status')).toHaveText('Sent to Pricing', { timeout: 60_000 });
  await expect(mac.page.getByTestId('mic')).toHaveAttribute('aria-pressed', 'false');

  const [id] = readdirSync(join(cwd, '.feedback', 'sketches'));
  const dir = join(cwd, '.feedback', 'sketches', id);
  expect(readdirSync(dir)).toEqual(expect.arrayContaining(['sketch.png', 'board.excalidraw', 'timeline.md', 'transcript.json', 'audio']));
  expect(readdirSync(join(dir, 'audio'))).toEqual(['seg-0.webm']);
  const timeline = readFileSync(join(dir, 'timeline.md'), 'utf8');
  expect(timeline).toMatch(/stroke 1/);
  expect(timeline).toMatch(/stroke 2/);
  expect(timeline).toMatch(/This pricing table is too dense/);
  expect(timeline).toMatch(/2 strokes/);

  // The session starts over: a later Send without voice is the iPad's sketch alone.
  await ipad.getByTestId('send').click();
  await expect.poll(() => readdirSync(join(cwd, '.feedback', 'sketches')).length).toBe(2);
  const second = readdirSync(join(cwd, '.feedback', 'sketches')).find((d) => d !== id)!;
  expect(readdirSync(join(cwd, '.feedback', 'sketches', second)).sort()).toEqual(['board.excalidraw', 'sketch.png']);
});
