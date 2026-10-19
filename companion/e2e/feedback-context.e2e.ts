import { expect, test } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FeedbackDocument, FeedbackSnapResult, ReadResponse } from '../src/protocol';
import { launchShown, sock, tempDataDir, type Launched } from './helpers';

let ctx: Launched;
test.afterEach(async () => { await ctx?.app.close(); });

const VIOLET = [139, 92, 246];
const GREEN = [40, 160, 90];
/** The panel crop comes through the display's colour profile, so its colours are only close. */
const near = (rgb: number[], want: number[]) => rgb.every((v, i) => Math.abs(v - want[i]!) < 60);

/** A small control inside a 480×320 section, 20px from the page's corner. */
const SECTION = (above = 0) => `<!doctype html><style>
  body { margin: 0; background: #fff }
  section { margin: ${20 + above}px 20px 20px; width: 480px; height: 320px; background: rgb(40, 160, 90); position: relative }
  #coupon { position: absolute; left: 100px; top: 100px; width: 80px; height: 30px; background: #fff }
</style><section id="cart"><div id="coupon"></div></section>`;

async function session(id: string, html: string) {
  const h = await launchShown();
  ctx = h.ctx;
  const cwd = tempDataDir();
  writeFileSync(join(cwd, 'cart.html'), html);
  await sock(h.socketPath, 'POST', '/sessions', { sessionId: id, cwd, title: 'Cart' });
  const route = `/sessions/${id}/feedback?path=cart.html`;
  const { body: doc } = await sock<FeedbackDocument>(h.socketPath, 'GET', route);
  const ops = [{ op: 'addRound', label: 'SME' }, { op: 'addItem', title: 'Coupon box is unclear', lines: [{ key: 'Src', text: '1 · Dev · 01:00 · "What is this box?"' }, { key: 'Where', text: '#coupon' }] }];
  expect((await sock(h.socketPath, 'POST', route, { version: doc.version, ops })).status).toBe(200);
  return { ...h, cwd };
}

/** A picture's size and the colour at a point given as fractions of its size, read in main from a file or a data URL. */
const pixel = (source: { file?: string; data?: string }, fx: number, fy: number) =>
  ctx.app.evaluate(({ nativeImage }, [source, fx, fy]) => {
    const { file, data } = source as { file?: string; data?: string };
    const img = file ? nativeImage.createFromPath(file) : nativeImage.createFromDataURL(data!);
    const { width, height } = img.getSize();
    const bmp = img.toBitmap();
    const at = (Math.floor((fy as number) * (height - 1)) * width + Math.floor((fx as number) * (width - 1))) * 4;
    // toBitmap is BGRA.
    return { width, height, rgb: [bmp[at + 2], bmp[at + 1], bmp[at]] };
  }, [source, fx, fy] as const);

test('a snap pictures the element inside its section, outlined', async () => {
  const { socketPath, cwd } = await session('fc-1', SECTION());
  const res = await sock<FeedbackSnapResult>(socketPath, 'POST', '/sessions/fc-1/feedback/snap?path=cart.html', { item: 1, side: 'before' });
  expect(res.status).toBe(200);
  // The section with 8px around it: 496×336, its corner at the page's (12, 12).
  const file = join(cwd, res.body.picture);
  const inside = await pixel({ file }, 300 / 496, 250 / 336);
  expect(inside.width / inside.height).toBeCloseTo(496 / 336, 2);
  expect(inside.rgb).toEqual(GREEN);
  // The coupon sits at (108, 108) in the picture, with a 3px outline just outside it.
  expect((await pixel({ file }, 106.5 / 496, 123 / 336)).rgb).toEqual(VIOLET);
});

test('a workspace seed crops the element inside its section, outlined', async () => {
  const { socketPath } = await session('fc-2', SECTION());
  const { page } = ctx;
  // Keep the panel crop the seed makes.
  await ctx.app.evaluate(() => {
    const g = globalThis as unknown as { __companion: { panel: { capture(rect: unknown): Promise<string | undefined> } }; __crop?: string };
    const panel = g.__companion.panel;
    const capture = panel.capture.bind(panel);
    panel.capture = async (rect) => (g.__crop = await capture(rect));
  });
  await sock(socketPath, 'POST', '/open', { sessionId: 'fc-2', output: { path: 'cart.html' } });
  await page.getByTestId('feedback-tab').click();
  await page.getByTestId('feedback-item-1').getByTestId('feedback-expand').click();
  await page.getByTestId('feedback-item-1').getByTestId('feedback-workspace-open').click();
  const elements = async () => (await sock<ReadResponse>(socketPath, 'GET', '/boards/fb-cart-1/elements')).body.elements;
  await expect.poll(async () => (await elements())?.some((e) => e.type === 'image') ?? false).toBe(true);
  const data = await ctx.app.evaluate(() => (globalThis as unknown as { __crop?: string }).__crop);
  expect(data).toBeTruthy();
  // The pane pads its crop by 12px, so the section is 504×344 with its corner at (12, 12).
  const inside = await pixel({ data }, 312 / 504, 262 / 344);
  expect(inside.width / inside.height).toBeCloseTo(504 / 344, 1);
  expect(near(inside.rgb, GREEN), String(inside.rgb)).toBe(true);
  const outline = (await pixel({ data }, 110.5 / 504, 127 / 344)).rgb;
  expect(near(outline, VIOLET), String(outline)).toBe(true);
});

test('Show on page scrolls the element into view and keeps it outlined', async () => {
  const { socketPath } = await session('fc-3', SECTION(2000));
  const { page } = ctx;
  await sock(socketPath, 'POST', '/open', { sessionId: 'fc-3', output: { path: 'cart.html' } });
  await page.getByTestId('feedback-tab').click();
  const coupon = page.frameLocator('[data-testid="review-frame"]').locator('#coupon');
  await expect(coupon).not.toBeInViewport();
  await page.getByTestId('feedback-item-1').getByTestId('feedback-expand').click();
  await page.getByTestId('feedback-item-1').getByTestId('feedback-show').click();
  await expect(coupon).toBeInViewport();
  // The pulse is over by now, and the outline stays.
  await page.waitForTimeout(2000);
  const box = (await coupon.boundingBox())!;
  const shot = await page.screenshot({ clip: { x: box.x - 3, y: box.y + box.height / 2 - 1, width: 3, height: 2 } });
  expect((await pixel({ data: `data:image/png;base64,${shot.toString('base64')}` }, 0.5, 0.5)).rgb).toEqual(VIOLET);
});
