import { expect, test, type Page } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExcalidrawFrameElement, OrderedExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import { backend, boardMenu, launch, RESULTS, sceneElements, showPanel, tempDataDir, type Launched } from './helpers';

let ctx: Launched;
let dataDir: string;

test.beforeEach(async () => {
  dataDir = tempDataDir();
  ctx = await launch(dataDir);
  await showPanel(ctx.app, ctx.page);
});

test.afterEach(async () => {
  await ctx.app.close();
});

type Shot = { width: number; height: number; color: string };

/** Drops or pastes solid-colour screenshots made in the page. `at` is a point on the canvas, in screen pixels. */
function deliver(page: Page, how: 'drop' | 'paste', shots: Shot[], at?: { x: number; y: number }): Promise<void> {
  return page.evaluate(
    async ({ how, shots, at }) => {
      const data = new DataTransfer();
      for (const [i, s] of shots.entries()) {
        const c = document.createElement('canvas');
        c.width = s.width;
        c.height = s.height;
        const g = c.getContext('2d')!;
        g.fillStyle = s.color;
        g.fillRect(0, 0, s.width, s.height);
        const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), 'image/png'));
        data.items.add(new File([blob], `shot-${i}.png`, { type: 'image/png' }));
      }
      if (how === 'paste') {
        (document.querySelector('.excalidraw') as HTMLElement).focus();
        document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
        return;
      }
      const canvas = document.querySelector('canvas.excalidraw__canvas.interactive')!;
      canvas.dispatchEvent(new DragEvent('drop', { dataTransfer: data, clientX: at!.x, clientY: at!.y, bubbles: true, cancelable: true }));
    },
    { how, shots, at },
  );
}

interface Group {
  name: string | null;
  id: string;
  images: { id: string; x: number; y: number; width: number; height: number }[];
}

/** Stack groups top to bottom, each with its pictures left to right. */
async function groups(page: Page): Promise<Group[]> {
  const els = (await sceneElements(page)).filter((e) => !e.isDeleted);
  return els
    .filter((e): e is OrderedExcalidrawElement & ExcalidrawFrameElement => e.type === 'frame' && !!e.customData?.stack)
    .sort((a, b) => a.y - b.y)
    .map((f) => ({
      name: f.name,
      id: f.id,
      images: els
        .filter((e) => e.type === 'image' && e.frameId === f.id)
        .sort((a, b) => a.y - b.y || a.x - b.x)
        .map(({ id, x, y, width, height }) => ({ id, x, y, width, height })),
    }));
}

const shape = async (page: Page) => (await groups(page)).map((g) => `${g.name}:${g.images.length}`);

/** A point on screen over a scene point. */
function onScreen(page: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  return page.evaluate(
    ({ x, y }) => {
      const s = window.__excalidraw.getAppState();
      return { x: (x + s.scrollX) * s.zoom.value + s.offsetLeft, y: (y + s.scrollY) * s.zoom.value + s.offsetTop };
    },
    { x, y },
  );
}

/** Waits until the view stops moving, so screen points map to the scene it settles on. */
async function settled(page: Page): Promise<void> {
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

/** True when a frame and its name show inside the canvas viewport. */
function inView(page: Page, id: string): Promise<boolean> {
  return page.evaluate((id) => {
    const api = window.__excalidraw;
    const s = api.getAppState();
    const f = api.getSceneElements().find((e) => e.id === id);
    const top = -s.scrollY;
    const bottom = top + s.height / s.zoom.value;
    return !!f && f.y - 24 >= top && f.y + f.height <= bottom;
  }, id);
}

test('a Stack board files each drop or paste as a numbered group', async () => {
  const { app, page } = ctx;
  await backend(app, 'open', { board: 'shots', layout: 'stack' });
  await expect(page.getByTestId('layout-stack')).toHaveAttribute('aria-checked', 'true');
  const listed = await backend(app, 'listBoards');
  expect(listed.boards.find((b: { name: string }) => b.name === 'shots')?.layout).toBe('stack');

  // Two files in one drop share a group, side by side. Large pictures shrink to fit.
  const canvas = (await page.locator('canvas.excalidraw__canvas.interactive').boundingBox())!;
  await deliver(page, 'drop', [{ width: 1600, height: 1000, color: '#e66' }, { width: 300, height: 200, color: '#6a6' }], {
    x: canvas.x + canvas.width - 40,
    y: canvas.y + canvas.height - 40,
  });
  await expect.poll(() => shape(page)).toEqual(['1:2']);
  const [first] = await groups(page);
  expect(first.images[0].y).toBe(first.images[1].y);
  expect(first.images[1].x).toBeGreaterThan(first.images[0].x + first.images[0].width);
  expect(first.images[0].width).toBeLessThanOrEqual(480);

  // A paste with nothing selected starts the next group, below the first.
  await deliver(page, 'paste', [{ width: 400, height: 300, color: '#66e' }]);
  await expect.poll(() => shape(page)).toEqual(['1:2', '2:1']);

  // The view moves to the new group.
  const added = (await groups(page))[1].id;
  await expect.poll(() => inView(page, added)).toBe(true);

  // A paste with a group selected joins that group.
  await page.evaluate((id) => window.__excalidraw.updateScene({ appState: { selectedElementIds: { [id]: true } } }), first.id);
  await deliver(page, 'paste', [{ width: 400, height: 300, color: '#ea3' }]);
  await expect.poll(() => shape(page)).toEqual(['1:3', '2:1']);

  // A drop on a group joins it.
  const second = (await groups(page))[1];
  const pic = second.images[0];
  await settled(page);
  await deliver(page, 'drop', [{ width: 200, height: 200, color: '#3ae' }], await onScreen(page, pic.x + 10, pic.y + 10));
  await expect.poll(() => shape(page)).toEqual(['1:3', '2:2']);

  // A picture dragged out to empty space gets its own group at the end.
  const moved = (await groups(page))[0].images[2].id;
  await page.evaluate((id) => {
    const api = window.__excalidraw;
    const els = api.getSceneElementsIncludingDeleted().map((e) => (e.id === id ? { ...e, x: 3000, y: 3000, version: e.version + 1 } : e));
    api.updateScene({ elements: els, captureUpdate: 'IMMEDIATELY' });
  }, moved);
  await expect.poll(() => shape(page)).toEqual(['1:2', '2:2', '3:1']);

  // Every picture shows on the canvas, not as a loading placeholder.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const api = window.__excalidraw;
        const files = api.getFiles();
        return api.getSceneElements().filter((e) => e.type === 'image' && !files[e.fileId!]).length;
      }),
    )
    .toBe(0);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(RESULTS, 'stack-panel.png') });

  // Send names the pictures by group, and the frames are not counted as strokes.
  const delivery = await app.evaluate(async () => {
    const d = await globalThis.__companion.buildDelivery();
    return { png: d.png!.toString('base64'), timeline: d.timelineMd as string };
  });
  writeFileSync(join(RESULTS, 'stack.png'), Buffer.from(delivery.png, 'base64'));
  expect(delivery.timeline).toContain('pasted image 1a');
  expect(delivery.timeline).toContain('pasted image 2b');
  expect(delivery.timeline).toContain('pasted image 3');
  expect(delivery.timeline).toContain('0 strokes');
  expect(delivery.timeline).not.toContain('frame');

  // The layout lives in the board file.
  await page.evaluate(() => window.__board.flush());
  const file = JSON.parse(readFileSync(join(dataDir, 'boards', 'shots.excalidraw'), 'utf8'));
  expect(file.agentBrief).toEqual({ layout: 'stack' });

  // Canvas turns it off. A paste then lands where Excalidraw puts it, and nothing else moves.
  const boxes = async () =>
    Object.fromEntries((await groups(page)).flatMap((g) => g.images).map(({ id, x, y }) => [id, `${Math.round(x)},${Math.round(y)}`]));
  const before = await boxes();
  await page.getByTestId('layout-freeform').click();
  await expect(page.getByTestId('layout-freeform')).toHaveAttribute('aria-checked', 'true');
  // Excalidraw pastes at the pointer.
  await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
  await deliver(page, 'paste', [{ width: 200, height: 200, color: '#999' }]);
  await expect.poll(async () => (await sceneElements(page)).filter((e) => e.type === 'image' && !e.isDeleted).length).toBe(6);
  const after = await boxes();
  for (const [id, at] of Object.entries(before)) expect(after[id]).toBe(at);
  await page.evaluate(() => window.__board.flush());
  expect(JSON.parse(readFileSync(join(dataDir, 'boards', 'shots.excalidraw'), 'utf8')).agentBrief).toBeUndefined();
});

test('marks drawn on a screenshot move with it', async () => {
  const { app, page } = ctx;
  await backend(app, 'open', { board: 'marks', layout: 'stack' });
  await deliver(page, 'paste', [{ width: 400, height: 300, color: '#e66' }]);
  await deliver(page, 'paste', [{ width: 400, height: 300, color: '#6a6' }]);
  await expect.poll(() => shape(page)).toEqual(['1:1', '2:1']);
  const [one, two] = await groups(page);
  // A mark on picture 2, inside its group.
  await backend(app, 'draw', 'marks', {
    elements: [{ type: 'rectangle', x: two.images[0].x + 20, y: two.images[0].y + 20, width: 60, height: 40, frameId: two.id }],
  });
  // Deleting group 1's picture moves group 2 up, mark and all.
  await page.evaluate((id) => {
    const api = window.__excalidraw;
    const els = api.getSceneElementsIncludingDeleted().map((e) => (e.id === id ? { ...e, isDeleted: true, version: e.version + 1 } : e));
    api.updateScene({ elements: els, captureUpdate: 'IMMEDIATELY' });
  }, one.images[0].id);
  await expect.poll(() => shape(page)).toEqual(['1:1']);
  const [moved] = await groups(page);
  const mark = (await sceneElements(page)).find((e) => e.type === 'rectangle' && !e.isDeleted)!;
  expect(mark.x - moved.images[0].x).toBeCloseTo(20);
  expect(mark.y - moved.images[0].y).toBeCloseTo(20);
  expect(mark.frameId).toBe(moved.id);
});

test('a new board can start as a Stack, and the board list marks it', async () => {
  const { page } = ctx;
  await expect(page.getByTestId('layout-freeform')).toHaveAttribute('aria-checked', 'true');

  await boardMenu(page, 'board-new');
  await page.getByTestId('board-name').fill('flows');
  await page.getByTestId('board-name').locator('..').getByTestId('layout-stack').click();
  await expect(page.getByTestId('board-name')).toBeFocused();
  await page.getByTestId('board-name').press('Enter');

  await expect(page.getByTestId('board-picker')).toContainText('flows');
  await expect(page.getByTestId('layout-stack')).toHaveAttribute('aria-checked', 'true');
  await page.evaluate(() => window.__board.flush());
  expect(JSON.parse(readFileSync(join(dataDir, 'boards', 'flows.excalidraw'), 'utf8')).agentBrief).toEqual({ layout: 'stack' });

  // The sidebar and, with the sidebar hidden, the board menu mark the Stack board.
  const listed = page.getByTestId('brief-board');
  await expect(listed.filter({ hasText: 'flows' }).getByTestId('board-stack-mark')).toBeVisible();
  await expect(listed.filter({ hasText: 'scratch' }).getByTestId('board-stack-mark')).toHaveCount(0);
  await page.getByTestId('sidebar-toggle').click();
  await page.getByTestId('board-picker').click();
  const rows = page.getByTestId('board-item');
  await expect(rows.filter({ hasText: 'flows' }).getByTestId('board-stack-mark')).toBeVisible();
  await expect(rows.filter({ hasText: 'scratch' }).getByTestId('board-stack-mark')).toHaveCount(0);
  await page.screenshot({ path: join(RESULTS, 'stack-board-menu.png') });
});
