import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import {
  RESULTS,
  inkWidthAt,
  interactiveCanvas,
  launch,
  penStroke,
  sceneElements,
  showPanel,
  syntheticStroke,
  tempDataDir,
  type Launched,
} from './helpers';

let ctx: Launched;

test.beforeEach(async () => {
  ctx = await launch(tempDataDir());
  await showPanel(ctx.app, ctx.page);
});

test.afterEach(async () => {
  await ctx.app.close();
});

const live = async () => (await sceneElements(ctx.page)).filter((e) => !e.isDeleted);

test('C1.2 pen pressure 0.2 vs 1.0 gives at least 2x stroke width (S5)', async () => {
  const { page } = ctx;
  const cdp = await page.context().newCDPSession(page);
  const box = (await interactiveCanvas(page).boundingBox())!;
  const x0 = box.x + 300;
  const x1 = box.x + 700;
  const light = { y: box.y + 300 };
  const heavy = { y: box.y + 450 };
  await penStroke(cdp, { x: x0, y: light.y }, { x: x1, y: light.y }, 0.2);
  await penStroke(cdp, { x: x0, y: heavy.y }, { x: x1, y: heavy.y }, 1.0);
  await page.waitForTimeout(300);

  const strokes = (await live()).filter((e) => e.type === 'freedraw');
  expect(strokes).toHaveLength(2);
  const [a, b] = strokes;
  expect(a.simulatePressure).toBe(false);
  expect(b.simulatePressure).toBe(false);
  const mid = (p: number[]) => p[Math.floor(p.length / 2)];
  const lightP = mid(a.pressures);
  const heavyP = mid(b.pressures);

  const xm = (x0 + x1) / 2;
  const lightW = await inkWidthAt(page, xm, light.y);
  const heavyW = await inkWidthAt(page, xm, heavy.y);

  // The same strokes with raw pressures, to show what Excalidraw does without the curve.
  await page.evaluate(
    ({ a, rawY, raw }) => {
      const api = (window as any).__excalidraw;
      const els = api.getSceneElementsIncludingDeleted();
      const zoom = api.getAppState().zoom.value;
      const extra = raw.map((p: number, i: number) => ({
        ...a,
        id: `raw-${i}`,
        y: a.y + (rawY[i] / zoom),
        pressures: a.pressures.map(() => p),
        version: 1,
        versionNonce: i + 1,
        index: null,
      }));
      api.updateScene({ elements: [...els, ...extra], captureUpdate: 'NEVER' });
    },
    { a, rawY: [300, 380], raw: [0.2, 1.0] },
  );
  await page.waitForTimeout(300);
  const rawLightW = await inkWidthAt(page, xm, light.y + 300);
  const rawHeavyW = await inkWidthAt(page, xm, light.y + 380);
  await page.screenshot({ path: join(RESULTS, 'c1.2-pressure.png') });

  const ratio = heavyW / lightW;
  const rawRatio = rawHeavyW / rawLightW;
  console.log(
    `[S5] stored pressure light=${lightP.toFixed(3)} heavy=${heavyP.toFixed(3)}; ` +
      `width light=${lightW.toFixed(2)} heavy=${heavyW.toFixed(2)} ratio=${ratio.toFixed(2)}; ` +
      `raw (no curve) light=${rawLightW.toFixed(2)} heavy=${rawHeavyW.toFixed(2)} ratio=${rawRatio.toFixed(2)}`,
  );
  expect(lightP).toBeLessThan(0.2);
  expect(heavyP).toBeCloseTo(1, 2);
  expect(lightW).toBeGreaterThan(0);
  expect(ratio).toBeGreaterThanOrEqual(2);
});

test('C1.3 eraser button erases, then the pen tool comes back', async () => {
  const { page } = ctx;
  const cdp = await page.context().newCDPSession(page);
  const box = (await interactiveCanvas(page).boundingBox())!;
  const y = box.y + 300;
  await penStroke(cdp, { x: box.x + 300, y }, { x: box.x + 600, y }, 0.7);
  await page.waitForTimeout(200);
  expect((await live()).filter((e) => e.type === 'freedraw')).toHaveLength(1);

  // A Wacom eraser reports pointerType pen with buttons=32. Chrome maps it to button 5.
  const across = [0, 1, 2, 3, 4].map((i) => ({ x: box.x + 450, y: y - 40 + i * 20 }));
  await syntheticStroke(page, across, { pointerType: 'pen', button: 5, buttons: 32, pointerId: 7 });
  await page.waitForTimeout(200);
  expect(await live()).toHaveLength(0);
  const tool = await page.evaluate(() => (window as any).__excalidraw.getAppState().activeTool.type);
  expect(tool).toBe('freedraw');
});

test('C1.3 eraser with buttons=32 and button 0 also erases', async () => {
  const { page } = ctx;
  const cdp = await page.context().newCDPSession(page);
  const box = (await interactiveCanvas(page).boundingBox())!;
  const y = box.y + 300;
  await penStroke(cdp, { x: box.x + 300, y }, { x: box.x + 600, y }, 0.7);
  await page.waitForTimeout(200);
  const across = [0, 1, 2, 3, 4].map((i) => ({ x: box.x + 450, y: y - 40 + i * 20 }));
  await syntheticStroke(page, across, { pointerType: 'pen', button: 0, buttons: 32, pointerId: 8 });
  await page.waitForTimeout(200);
  expect(await live()).toHaveLength(0);
});

test('C1.3 touch is ignored while the pen is in range', async () => {
  const { page } = ctx;
  const box = (await interactiveCanvas(page).boundingBox())!;
  const line = (y: number) => [0, 1, 2, 3, 4, 5].map((i) => ({ x: box.x + 300 + i * 40, y: box.y + y }));

  // No pen yet: a finger draws.
  await syntheticStroke(page, line(200), { pointerType: 'touch', button: 0, buttons: 1, pointerId: 20 });
  await page.waitForTimeout(200);
  expect(await live()).toHaveLength(1);

  // The pen hovers nearby: the finger is ignored.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x + 100, y: box.y + 500, pointerType: 'pen' } as never);
  await syntheticStroke(page, line(300), { pointerType: 'touch', button: 0, buttons: 1, pointerId: 21 });
  await page.waitForTimeout(200);
  expect(await live()).toHaveLength(1);

  // The pen leaves range: after the range timeout a finger draws again.
  await page.evaluate(() =>
    window.dispatchEvent(new PointerEvent('pointerout', { pointerType: 'pen', pointerId: 1, bubbles: true })),
  );
  await page.waitForTimeout(1100);
  await syntheticStroke(page, line(400), { pointerType: 'touch', button: 0, buttons: 1, pointerId: 22 });
  await page.waitForTimeout(200);
  expect(await live()).toHaveLength(2);
});
