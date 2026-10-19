import { expect, test } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import type { FeedbackDocument, FeedbackSnapResult } from '../src/protocol';
import { launchShown, sock, tempDataDir, type Launched } from './helpers';

let ctx: Launched;
let server: http.Server | undefined;
test.afterEach(async () => {
  await ctx?.app.close();
  server?.close();
  server = undefined;
});

const put = (cwd: string, rel: string, text: string) => {
  mkdirSync(dirname(join(cwd, rel)), { recursive: true });
  writeFileSync(join(cwd, rel), text);
};

async function agent(socketPath: string, route: string, ops: unknown[]) {
  const { body: doc } = await sock<FeedbackDocument>(socketPath, 'GET', route);
  const res = await sock(socketPath, 'POST', route, { version: doc.version, ops });
  expect(res.status).toBe(200);
}

/** A picture's size and the colour at a point given as fractions of its size, read in main. */
const pixel = (file: string, fx: number, fy: number) =>
  ctx.app.evaluate(({ nativeImage }, [file, fx, fy]) => {
    const img = nativeImage.createFromPath(file as string);
    const { width, height } = img.getSize();
    const bmp = img.toBitmap();
    const at = (Math.floor((fy as number) * (height - 1)) * width + Math.floor((fx as number) * (width - 1))) * 4;
    // toBitmap is BGRA.
    return { width, height, rgb: [bmp[at + 2], bmp[at + 1], bmp[at]] };
  }, [file, fx, fy] as const);

async function session(id: string) {
  const h = await launchShown();
  ctx = h.ctx;
  const cwd = tempDataDir();
  await sock(h.socketPath, 'POST', '/sessions', { sessionId: id, cwd, title: 'Snaps' });
  const snap = (path: string, item: number, side: string) => sock<FeedbackSnapResult>(h.socketPath, 'POST', `/sessions/${id}/feedback/snap?path=${path}`, { item, side });
  return { ...h, cwd, snap };
}

test('without Where it captures the whole page, and clips a very tall page and says so', async () => {
  const { socketPath, cwd, snap } = await session('fs-1');
  const tall = (height: number) => `<!doctype html><style>body{margin:0}</style><div style="height:${height - 100}px;background:#fff"></div><div style="height:100px;background:rgb(0,0,255)"></div>`;
  put(cwd, 'tall.html', tall(3000));
  put(cwd, 'huge.html', tall(12000));
  for (const path of ['tall.html', 'huge.html']) await agent(socketPath, `/sessions/fs-1/feedback?path=${path}`, [{ op: 'addRound', label: 'SME' }, { op: 'addItem', title: 'Footer' }]);

  const whole = await snap('tall.html', 1, 'before');
  expect(whole.status).toBe(200);
  expect(whole.body.clipped).toBeUndefined();
  const shot = await pixel(join(cwd, whole.body.picture), 0.5, 0.99);
  expect(shot.width / shot.height).toBeCloseTo(1280 / 3000, 2);
  // The change below the first viewport is in the picture.
  expect(shot.rgb).toEqual([0, 0, 255]);

  const clipped = await snap('huge.html', 1, 'before');
  expect(clipped.status).toBe(200);
  expect(clipped.body.clipped).toBe(10_000);
  const top = await pixel(join(cwd, clipped.body.picture), 0.5, 0.99);
  expect(top.width / top.height).toBeCloseTo(1280 / 10_000, 3);
  expect(top.rgb).toEqual([255, 255, 255]);
  expect(readFileSync(join(cwd, 'huge.html.feedback.md'), 'utf8')).toContain('    Before: huge.html.feedback/1-r1-before.png · clipped to the top 10000px\n');
});

/** A local server that records what asks it for anything. */
async function recorder() {
  const asked: string[] = [];
  server = http.createServer((req, res) => {
    asked.push(req.url ?? '');
    res.writeHead(200, { 'content-type': 'text/html', 'access-control-allow-origin': '*' });
    // `/hold` keeps the page loading a moment, so its scripts settle before the capture.
    setTimeout(() => res.end('<!doctype html><p>external frame</p>'), req.url === '/hold' ? 1500 : 0);
  });
  await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done));
  return { asked, origin: `http://127.0.0.1:${(server!.address() as AddressInfo).port}` };
}

test('a capture keeps frames on the review scheme and grants no media', async () => {
  const { socketPath, cwd, snap } = await session('fs-2');
  const { asked, origin } = await recorder();
  put(cwd, 'framed.html', `<!doctype html><body><h1>Framed</h1><iframe src="${origin}/frame" allow="microphone"></iframe><iframe src="inner.html"></iframe><img src="${origin}/hold">
<script>
  const beacon = (what) => { new Image().src = '${origin}/' + what; };
  navigator.mediaDevices.getUserMedia({ audio: true }).then(() => beacon('media-granted'), () => beacon('media-denied'));
</script></body>`);
  put(cwd, 'inner.html', `<!doctype html><p>inner</p><script>new Image().src = '${origin}/inner-loaded';</script>`);
  await agent(socketPath, '/sessions/fs-2/feedback?path=framed.html', [{ op: 'addRound', label: 'SME' }, { op: 'addItem', title: 'Frames' }]);

  expect((await snap('framed.html', 1, 'before')).status).toBe(200);
  await expect.poll(() => asked).toContain('/media-denied');
  // A frame on the review scheme loads; the external frame never asks.
  await expect.poll(() => asked).toContain('/inner-loaded');
  expect(asked).not.toContain('/frame');
  expect(asked).not.toContain('/media-granted');
});

test('a capture shows no dialogs', async () => {
  const { socketPath, cwd, snap } = await session('fs-3');
  const { asked, origin } = await recorder();
  put(cwd, 'alert.html', `<!doctype html><h1>Alert</h1><script>alert('hi'); confirm('sure?'); new Image().src = '${origin}/after-dialogs';</script>`);
  await agent(socketPath, '/sessions/fs-3/feedback?path=alert.html', [{ op: 'addRound', label: 'SME' }, { op: 'addItem', title: 'Alert' }]);
  const started = Date.now();
  expect((await snap('alert.html', 1, 'before')).status).toBe(200);
  expect(Date.now() - started).toBeLessThan(10_000);
  await expect.poll(() => asked).toContain('/after-dialogs');
  expect(await ctx.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => w.isVisible()).map((w) => w.getTitle()))).toEqual(['Agent Brief']);
});

test('a retake adds a picture, keeps the first Before, and the open card shows the latest After', async () => {
  const { socketPath, cwd, snap } = await session('fs-4');
  const page = (color: string) => `<!doctype html><style>body{margin:0}#filters{width:300px;height:120px;margin:40px;background:${color}}</style><div id="filters">Filters</div>`;
  put(cwd, 'checkout.html', page('rgb(220, 40, 40)'));
  await agent(socketPath, '/sessions/fs-4/feedback?path=checkout.html', [{ op: 'addRound', label: 'SME' }, { op: 'addItem', title: 'Filters', lines: [{ key: 'Where', text: '#filters' }] }]);
  expect((await snap('checkout.html', 1, 'before')).status).toBe(200);
  put(cwd, 'checkout.html', page('rgb(40, 160, 90)'));
  expect((await snap('checkout.html', 1, 'after')).status).toBe(200);

  const panel = ctx.page;
  await sock(socketPath, 'POST', '/open', { sessionId: 'fs-4', output: { path: 'checkout.html' } });
  await panel.getByTestId('feedback-tab').click();
  await panel.getByTestId('feedback-item-1').getByTestId('feedback-expand').click();
  const slider = panel.getByTestId('feedback-item-1').getByTestId('feedback-slider');
  await expect(slider.locator('img')).toHaveCount(2);
  const src = async (sel: string) => (await slider.locator(sel).getAttribute('src')) ?? '';
  const before = await src('img.before');
  const after = await src('img:not(.before)');

  put(cwd, 'checkout.html', page('rgb(40, 40, 220)'));
  const retake = await snap('checkout.html', 1, 'after');
  expect(retake.body.picture).toBe('checkout.html.feedback/1-r1-after-2.png');
  await expect.poll(() => src('img:not(.before)')).not.toBe(after);
  const again = await snap('checkout.html', 1, 'before');
  expect(again.body.picture).toBe('checkout.html.feedback/1-r1-before-2.png');
  await expect(panel.getByTestId('feedback-item-1')).toContainText('1-r1-before-2.png');
  expect(await src('img.before')).toBe(before);
  // The first pictures are kept as they were.
  expect((await pixel(join(cwd, 'checkout.html.feedback/1-r1-after.png'), 0.5, 0.5)).rgb).toEqual([40, 160, 90]);
  expect((await pixel(join(cwd, 'checkout.html.feedback/1-r1-after-2.png'), 0.5, 0.5)).rgb).toEqual([40, 40, 220]);
  expect(readFileSync(join(cwd, 'checkout.html.feedback.md'), 'utf8')).toContain(
    '    Before: checkout.html.feedback/1-r1-before.png\n    After: checkout.html.feedback/1-r1-after.png\n    After: checkout.html.feedback/1-r1-after-2.png\n    Before: checkout.html.feedback/1-r1-before-2.png\n',
  );
});
