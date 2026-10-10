import { expect, test } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReadResponse, Skeleton } from '../src/protocol';
import { backend, interactiveCanvas, launch, openNotes, penStroke, RESULTS, ROOT, sceneElements, showPanel, tempDataDir, type Launched } from './helpers';

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

const FLOW: Skeleton[] = [
  { type: 'frame', id: 'flow', label: 'Login flow' },
  { type: 'rectangle', id: 'start', x: 100, y: 100, label: 'Open the app', frameId: 'flow' },
  { type: 'diamond', id: 'check', x: 400, y: 90, label: 'Signed in?', frameId: 'flow' },
  { type: 'ellipse', id: 'done', x: 720, y: 95, label: 'Home', color: 'green', frameId: 'flow' },
  { type: 'arrow', id: 'a1', start: { id: 'start' }, end: { id: 'check' }, frameId: 'flow' },
  { type: 'arrow', id: 'a2', start: { id: 'check' }, end: { id: 'done' }, label: 'yes', frameId: 'flow' },
  { type: 'sticky', id: 'note', x: 400, y: 260, label: 'Remember SSO', frameId: 'flow' },
];

function pngSize(b64: string): { width: number; height: number; bytes: Buffer } {
  const bytes = Buffer.from(b64, 'base64');
  expect(bytes.subarray(1, 4).toString()).toBe('PNG');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), bytes };
}

const live = async () => (await sceneElements(ctx.page)).filter((e) => !e.isDeleted);

test('S6/C4.1 draw labelled shapes and bound arrows in a frame, then read them back', async () => {
  const { app, page } = ctx;
  const drawn = await backend(app, 'draw', 'current', { elements: FLOW });
  expect(drawn.ids).toEqual(['flow', 'start', 'check', 'done', 'a1', 'a2', 'note']);
  expect(drawn.batchId).toMatch(/^b_/);

  await page.evaluate(() => {
    const api = (window as any).__excalidraw;
    api.setActiveTool({ type: 'hand' });
    api.scrollToContent(undefined, { fitToViewport: true, viewportZoomFactor: 0.9 });
  });
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(RESULTS, 's6-draw.png') });

  const read: ReadResponse = await backend(app, 'read', 'current');
  const byId = Object.fromEntries(read.elements.map((e) => [e.id, e]));
  expect(Object.keys(byId).sort()).toEqual(['a1', 'a2', 'check', 'done', 'flow', 'note', 'start']);
  expect(byId.flow).toMatchObject({ type: 'frame', label: 'Login flow', by: 'claude' });
  expect(byId.start).toMatchObject({ type: 'rectangle', label: 'Open the app', frameId: 'flow', color: 'violet' });
  expect(byId.check).toMatchObject({ type: 'diamond', label: 'Signed in?', frameId: 'flow' });
  expect(byId.done).toMatchObject({ type: 'ellipse', label: 'Home', color: 'green' });
  expect(byId.a1).toMatchObject({ type: 'arrow', startId: 'start', endId: 'check', frameId: 'flow' });
  expect(byId.a2).toMatchObject({ type: 'arrow', startId: 'check', endId: 'done', label: 'yes' });
  expect(byId.note).toMatchObject({ type: 'sticky', label: 'Remember SSO', color: 'yellow' });
  for (const e of read.elements) {
    expect(e.by).toBe('claude');
    expect(e.createdAt).toBeGreaterThan(0);
  }

  // Arrows start and end just outside their shapes.
  expect(byId.a1.x).toBeGreaterThan(byId.start.x + byId.start.width);
  expect(byId.a1.x + byId.a1.width).toBeLessThan(byId.check.x + 1);
  // The frame wraps every child.
  for (const id of ['start', 'check', 'done', 'note']) {
    expect(byId[id].x).toBeGreaterThanOrEqual(byId.flow.x);
    expect(byId[id].x + byId[id].width).toBeLessThanOrEqual(byId.flow.x + byId.flow.width);
    expect(byId[id].y + byId[id].height).toBeLessThanOrEqual(byId.flow.y + byId.flow.height);
  }

  // Excalidraw's own bindings are in place, so dragging a shape would drag its arrows.
  const scene = await live();
  const el = (id: string) => scene.find((e) => e.id === id);
  expect(el('a1').startBinding.elementId).toBe('start');
  expect(el('start').boundElements.map((b: any) => b.id)).toContain('a1');
  expect(el('check').boundElements.map((b: any) => b.id)).toEqual(expect.arrayContaining(['a1', 'a2']));

  // A region read keeps only what touches it.
  const right: ReadResponse = await backend(app, 'read', 'current', { x: 700, y: 80, width: 300, height: 100 });
  expect(right.elements.map((e) => e.id).sort()).toEqual(['a2', 'done', 'flow']);

  // Ids that clash are remapped and returned in order; arrows can bind to earlier batches.
  const second = await backend(app, 'draw', 'current', {
    elements: [
      { type: 'rectangle', id: 'start', x: 100, y: 500, label: 'Again' },
      { type: 'arrow', start: { id: 'start' }, end: { id: 'note' } },
    ],
  });
  expect(second.ids[0]).not.toBe('start');
  const again: ReadResponse = await backend(app, 'read', 'current');
  const arrow = again.elements.find((e) => e.id === second.ids[1])!;
  expect(arrow).toMatchObject({ startId: second.ids[0], endId: 'note' });
});

test('C4.2 one undo removes Claude\'s batch and keeps the user\'s stroke', async () => {
  const { app, page } = ctx;
  const cdp = await page.context().newCDPSession(page);
  const box = (await interactiveCanvas(page).boundingBox())!;
  await penStroke(cdp, { x: box.x + 150, y: box.y + 500 }, { x: box.x + 450, y: box.y + 560 }, 0.6);
  await page.waitForTimeout(150);
  const user = (await live()).map((e) => e.id);
  expect(user).toHaveLength(1);

  await backend(app, 'draw', 'current', { elements: FLOW });
  expect((await live()).length).toBeGreaterThan(7);

  const undo = async () => {
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
    await page.waitForTimeout(150);
  };
  await undo();
  expect((await live()).map((e) => e.id)).toEqual(user);
  const read: ReadResponse = await backend(app, 'read', 'current');
  expect(read.elements.map((e) => e.by)).toEqual(['user']);

  // Update and delete are one undo step each too.
  await backend(app, 'draw', 'current', { elements: [{ type: 'rectangle', id: 'box', x: 0, y: 0, label: 'Move me' }] });
  const moved = await backend(app, 'update', 'current', { updates: [{ id: 'box', x: 300, y: 200, label: 'Moved', color: 'red' }, { id: 'nope', x: 1 }] });
  expect(moved.ids).toEqual(['box']);
  let box2 = (await backend<ReadResponse>(app, 'read', 'current')).elements.find((e) => e.id === 'box')!;
  expect(box2).toMatchObject({ x: 300, y: 200, label: 'Moved', color: 'red' });
  await undo();
  box2 = (await backend<ReadResponse>(app, 'read', 'current')).elements.find((e) => e.id === 'box')!;
  expect(box2).toMatchObject({ x: 0, y: 0, label: 'Move me' });

  const removed = await backend(app, 'remove', 'current', { ids: ['box', 'ghost'] });
  expect(removed.ids).toEqual(['box']);
  expect((await live()).some((e) => e.id === 'box')).toBe(false);
  await undo();
  expect((await live()).some((e) => e.id === 'box')).toBe(true);
  expect((await live()).some((e) => e.id === user[0])).toBe(true);
});

test('C4.3 png of a region keeps the long edge at 1400 or less', async () => {
  const { app } = ctx;
  await backend(app, 'draw', 'current', { elements: FLOW });
  const read: ReadResponse = await backend(app, 'read', 'current');

  const whole = pngSize((await backend(app, 'png', 'current', {})).base64);
  expect(Math.max(whole.width, whole.height)).toBeLessThanOrEqual(1400);
  writeFileSync(join(RESULTS, 'c4.3-whole.png'), whole.bytes);

  const wide = { x: read.bounds.x - 1000, y: read.bounds.y, width: 4000, height: 1000 };
  const region = pngSize((await backend(app, 'png', 'current', { region: wide })).base64);
  expect(region.width).toBe(1400);
  expect(region.height).toBe(350);

  const left = { x: 80, y: 60, width: 300, height: 200 };
  const crop = pngSize((await backend(app, 'png', 'current', { region: left, maxEdge: 500 })).base64);
  expect(crop).toMatchObject({ width: 500, height: 333 });
  writeFileSync(join(RESULTS, 'c4.3-region.png'), crop.bytes);

  const small = pngSize((await backend(app, 'png', 'current', { maxEdge: 300 })).base64);
  expect(Math.max(small.width, small.height)).toBe(300);
});

test('boards that are not visible are edited on disk and stay out of view', async () => {
  const { app } = ctx;
  const drawn = await backend(app, 'draw', 'backlog', { elements: [{ type: 'sticky', id: 's1', label: 'Later' }] });
  expect(drawn.ids).toEqual(['s1']);
  expect(await live()).toHaveLength(0);
  const read: ReadResponse = await backend(app, 'read', 'backlog');
  expect(read.elements).toMatchObject([{ id: 's1', type: 'sticky', label: 'Later' }]);
  const file = JSON.parse(readFileSync(join(dataDir, 'boards', 'backlog.excalidraw'), 'utf8'));
  expect(file.elements.some((e: any) => e.id === 's1')).toBe(true);

  await expect(backend(app, 'read', 'missing')).rejects.toThrow(/no board/);
  const boards = await backend(app, 'listBoards');
  expect(boards.boards.map((b: any) => b.name).sort()).toEqual(['backlog', 'scratch']);
  expect(boards.current).toBe('scratch');

  const opened = await backend(app, 'open', { board: 'backlog', prompt: 'Sketch the backlog', sessionId: 's-1' });
  expect(opened).toEqual({ board: 'backlog', targetSessionId: 's-1' });
  await expect(ctx.page.getByTestId('board-picker')).toHaveValue('backlog');
  await expect(ctx.page.getByTestId('prompt')).toHaveText(/Sketch the backlog/);
  expect((await live()).map((e) => e.id)).toContain('s1');
  expect(await backend(app, 'health')).toEqual({ panelVisible: true, currentBoard: 'backlog' });
});

test('Send builds the hand-off: png, scene and notes', async () => {
  const { app, page } = ctx;
  await backend(app, 'draw', 'current', { elements: FLOW });
  await openNotes(page);
  await page.getByTestId('notes').fill('make the flow shorter');
  const delivery = await app.evaluate(async () => {
    const d = await (globalThis as any).__companion.buildDelivery();
    return { ...d, png: d.png.toString('base64') };
  });
  expect(delivery.boardName).toBe('scratch');
  expect(delivery.notes).toBe('make the flow shorter');
  expect(delivery.scene.elements.length).toBeGreaterThanOrEqual(7);
  const png = pngSize(delivery.png);
  expect(Math.max(png.width, png.height)).toBeLessThanOrEqual(1400);
  writeFileSync(join(RESULTS, 'send.png'), png.bytes);

});

test('a paste lands deselected with the pen still in hand', async () => {
  const { page } = ctx;
  const png = readFileSync(join(ROOT, 'build/icons/icon-1024.png')).toString('base64');
  const state = () =>
    page.evaluate(() => {
      const api = (window as any).__excalidraw;
      const s = api.getAppState();
      return {
        tool: s.activeTool.type,
        selected: Object.keys(s.selectedElementIds).length,
        images: api.getSceneElements().filter((e: any) => e.type === 'image').length,
      };
    });
  expect((await state()).tool).toBe('freedraw');
  const box = (await interactiveCanvas(page).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const data = new DataTransfer();
    data.items.add(new File([bytes], 'shot.png', { type: 'image/png' }));
    (document.querySelector('.excalidraw') as HTMLElement).focus();
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, png);
  await expect.poll(async () => (await state()).images, { timeout: 5000 }).toBe(1);
  await expect.poll(state).toEqual({ tool: 'freedraw', selected: 0, images: 1 });

  // The pen draws straight away, and the PNG letters the image and numbers the stroke.
  const cdp = await page.context().newCDPSession(page);
  await penStroke(cdp, { x: box.x + box.width / 2 - 80, y: box.y + box.height / 2 }, { x: box.x + box.width / 2 + 80, y: box.y + box.height / 2 + 40 }, 0.7);
  await expect.poll(async () => (await sceneElements(page)).filter((e) => e.type === 'freedraw' && !e.isDeleted).length).toBe(1);
  const delivery = await ctx.app.evaluate(async () => {
    const d = await (globalThis as any).__companion.buildDelivery();
    return { png: d.png.toString('base64'), timeline: d.timelineMd };
  });
  expect(delivery.timeline).toContain('pasted image A');
  expect(delivery.timeline).toMatch(/stroke 1 · freehand · on image A/);
  writeFileSync(join(RESULTS, 'paste-letters.png'), Buffer.from(delivery.png, 'base64'));
});
