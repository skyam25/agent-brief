import { expect, test } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExcalidrawArrowElement } from '@excalidraw/excalidraw/element/types';
import type { ReadResponse } from '../src/protocol';
import { backend, FLOW, interactiveCanvas, launch, penStroke, pickPen, RESULTS, ROOT, sceneElements, showPanel, tempDataDir, type Launched } from './helpers';

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


const live = async () => (await sceneElements(ctx.page)).filter((e) => !e.isDeleted);

test('S6/C4.1 draw labelled shapes and bound arrows in a frame, then read them back', async () => {
  const { app, page } = ctx;
  const drawn = await backend(app, 'draw', 'current', { elements: FLOW });
  expect(drawn.ids).toEqual(['flow', 'start', 'check', 'done', 'a1', 'a2', 'note']);
  expect(drawn.batchId).toMatch(/^b_/);

  await page.evaluate(() => {
    const api = window.__excalidraw;
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
  const el = (id: string) => scene.find((e) => e.id === id)!;
  expect((el('a1') as ExcalidrawArrowElement).startBinding!.elementId).toBe('start');
  expect(el('start').boundElements!.map((b) => b.id)).toContain('a1');
  expect(el('check').boundElements!.map((b) => b.id)).toEqual(expect.arrayContaining(['a1', 'a2']));

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
  await pickPen(page);
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
  let box2 = (await backend(app, 'read', 'current')).elements.find((e) => e.id === 'box')!;
  expect(box2).toMatchObject({ x: 300, y: 200, label: 'Moved', color: 'red' });
  await undo();
  box2 = (await backend(app, 'read', 'current')).elements.find((e) => e.id === 'box')!;
  expect(box2).toMatchObject({ x: 0, y: 0, label: 'Move me' });

  const removed = await backend(app, 'remove', 'current', { ids: ['box', 'ghost'] });
  expect(removed.ids).toEqual(['box']);
  expect((await live()).some((e) => e.id === 'box')).toBe(false);
  await undo();
  expect((await live()).some((e) => e.id === 'box')).toBe(true);
  expect((await live()).some((e) => e.id === user[0])).toBe(true);
});

test('boards that are not visible are edited on disk and stay out of view', async () => {
  const { app } = ctx;
  const drawn = await backend(app, 'draw', 'backlog', { elements: [{ type: 'sticky', id: 's1', label: 'Later' }] });
  expect(drawn.ids).toEqual(['s1']);
  expect(await live()).toHaveLength(0);
  const read: ReadResponse = await backend(app, 'read', 'backlog');
  expect(read.elements).toMatchObject([{ id: 's1', type: 'sticky', label: 'Later' }]);
  const file: { elements: { id: string }[] } = JSON.parse(readFileSync(join(dataDir, 'boards', 'backlog.excalidraw'), 'utf8'));
  expect(file.elements.some((e) => e.id === 's1')).toBe(true);

  await expect(backend(app, 'read', 'missing')).rejects.toThrow(/no board/);
  const boards = await backend(app, 'listBoards');
  expect(boards.boards.map((b) => b.name).sort()).toEqual(['backlog', 'scratch']);
  expect(boards.current).toBe('scratch');

  const opened = await backend(app, 'open', { board: 'backlog', prompt: 'Sketch the backlog', sessionId: 's-1' });
  expect(opened).toEqual({ board: 'backlog', targetSessionId: 's-1' });
  await expect(ctx.page.getByTestId('board-picker')).toHaveText('backlog');
  await expect(ctx.page.getByTestId('prompt')).toHaveText(/Sketch the backlog/);
  expect((await live()).map((e) => e.id)).toContain('s1');
  expect(await backend(app, 'health')).toEqual({ panelVisible: true, currentBoard: 'backlog' });
});

test('a paste lands deselected with the pen still in hand', async () => {
  const { page } = ctx;
  const png = readFileSync(join(ROOT, 'build/icons/icon-1024.png')).toString('base64');
  const state = () =>
    page.evaluate(() => {
      const api = window.__excalidraw;
      const s = api.getAppState();
      return {
        tool: s.activeTool.type,
        selected: Object.keys(s.selectedElementIds).length,
        images: api.getSceneElements().filter((e) => e.type === 'image').length,
      };
    });
  // The board opens on the pointer; the person picks the pen to draw.
  expect((await state()).tool).toBe('selection');
  await pickPen(page);
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
    const d = await globalThis.__companion.buildDelivery();
    return { png: d.png!.toString('base64'), timeline: d.timelineMd };
  });
  expect(delivery.timeline).toContain('pasted image A');
  expect(delivery.timeline).toMatch(/stroke 1 · freehand · on image A/);
  writeFileSync(join(RESULTS, 'paste-letters.png'), Buffer.from(delivery.png, 'base64'));
});

test('a drawing at the origin of an empty board shows below the toolbar', async () => {
  const { app, page } = ctx;
  await backend(app, 'draw', 'current', {
    elements: [{ type: 'frame', id: 'f', x: 0, y: 0, width: 300, height: 200, label: 'Top' }, { type: 'rectangle', x: 40, y: 40, frameId: 'f' }],
  });
  await page.waitForTimeout(600);
  const { frameTop, toolbarBottom } = await page.evaluate(() => {
    const api = window.__excalidraw;
    const { scrollY, zoom, offsetTop } = api.getAppState();
    const root = document.querySelector('.excalidraw')!.getBoundingClientRect();
    const bar = document.querySelector('.excalidraw .App-toolbar')!.getBoundingClientRect();
    return { frameTop: root.top + (0 - 24 + scrollY) * zoom.value, toolbarBottom: bar.bottom, offsetTop };
  });
  expect(frameTop).toBeGreaterThanOrEqual(toolbarBottom);
  await page.screenshot({ path: join(RESULTS, 'reveal-below-toolbar.png') });
});

test('the opacity label sits at the knob once a selection shows the style panel', async () => {
  const { app, page } = ctx;
  // With the pen in hand the panel mounts hidden, and must measure its real width when a selection shows it.
  await pickPen(page);
  await page.locator('.excalidraw .range-input').waitFor({ state: 'attached' });
  await backend(app, 'draw', 'current', { elements: [{ type: 'rectangle', id: 'box', x: 0, y: 0, label: 'Pick me' }] });
  await page.evaluate(() => window.__excalidraw.updateScene({ appState: { selectedElementIds: { box: true } } }));
  await page.locator('.canvas[data-selection="true"] .App-menu__left').waitFor();
  const slider = await page.evaluate(() => {
    const input = document.querySelector<HTMLElement>('.excalidraw .range-input')!;
    const bubble = document.querySelector<HTMLElement>('.excalidraw .value-bubble')!;
    return { width: input.offsetWidth, left: parseFloat(bubble.style.left), text: bubble.textContent };
  });
  expect(slider.text).toBe('100');
  expect(slider.width).toBeGreaterThan(100);
  expect(slider.left).toBeCloseTo(slider.width - 7.5, 0);
});

test('the frame tool has its own toolbar button after the eraser', async () => {
  const { page } = ctx;
  const tool = () => page.evaluate(() => window.__excalidraw.getAppState().activeTool.type);
  const button = page.getByTestId('toolbar-frame-button');
  const trigger = page.locator('.App-toolbar__extra-tools-trigger');

  // It sits between the eraser and the More tools menu.
  const order = await page.evaluate(() =>
    [...document.querySelectorAll('.App-toolbar .Stack_horizontal [data-testid]')].map((el) => (el as HTMLElement).dataset.testid),
  );
  expect(order.slice(-3)).toEqual(['toolbar-eraser', 'toolbar-frame-button', 'dropdown-menu-button']);

  await button.click({ force: true });
  await expect.poll(tool).toBe('frame');
  await expect(button).toBeChecked();
  await expect(trigger).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await page.screenshot({ path: join(RESULTS, 'frame-tool-button.png') });

  const box = (await interactiveCanvas(page).boundingBox())!;
  await page.mouse.move(box.x + 200, box.y + 250);
  await page.mouse.down();
  await page.mouse.move(box.x + 500, box.y + 450, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await live()).filter((e) => e.type === 'frame').length).toBe(1);

  // Shortcuts still reach the board after a click on the button.
  await button.click({ force: true });
  await expect.poll(tool).toBe('frame');
  await page.keyboard.press('r');
  await expect.poll(tool).toBe('rectangle');
  await expect(button).not.toBeChecked();
  await page.keyboard.press('f');
  await expect(button).toBeChecked();
});

test('Cmd+A selects the board after a click on the panel controls', async () => {
  const { app, page } = ctx;
  await backend(app, 'draw', 'current', {
    elements: [
      { type: 'rectangle', id: 'a', x: 100, y: 100 },
      { type: 'ellipse', id: 'b', x: 300, y: 100 },
    ],
  });
  const state = () =>
    page.evaluate(() => ({
      selected: Object.keys(window.__excalidraw.getAppState().selectedElementIds).length,
      text: String(window.getSelection()),
    }));

  // A mode round trip hands focus back to the board.
  await page.getByTestId('mode-write').click();
  await page.getByTestId('mode-sketch').click();
  expect(await page.evaluate(() => document.activeElement?.classList.contains('excalidraw'))).toBe(true);

  // Focus left on a control still sends Cmd+A to the board.
  await page.getByTestId('mode-sketch').focus();
  await page.keyboard.press('Meta+a');
  expect(await state()).toEqual({ selected: 2, text: '' });
});

test('a paste lands on the board while focus and the pointer sit on the panel controls', async () => {
  const { page } = ctx;
  const png = readFileSync(join(ROOT, 'build/icons/icon-1024.png')).toString('base64');
  const tab = page.getByTestId('mode-sketch');
  await tab.hover();
  await tab.focus();
  const paste = (item: { text?: string; png?: string }) =>
    page.evaluate((item) => {
      const data = new DataTransfer();
      if (item.text) data.setData('text/plain', item.text);
      if (item.png) data.items.add(new File([Uint8Array.from(atob(item.png), (c) => c.charCodeAt(0))], 'shot.png', { type: 'image/png' }));
      (document.activeElement as HTMLElement).dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    }, item);
  const kinds = async () => (await live()).map((e) => e.type).sort();

  await paste({ text: 'pasted words' });
  await expect.poll(kinds, { timeout: 5000 }).toEqual(['text']);
  await tab.focus();
  await paste({ png });
  await expect.poll(kinds, { timeout: 5000 }).toEqual(['image', 'text']);
});

test('the wheel scrolls the board while a frame name sits under the pointer', async () => {
  const { app, page } = ctx;
  await backend(app, 'draw', 'current', { elements: [{ type: 'frame', id: 'f', label: 'Login flow' }, { type: 'rectangle', id: 'r', x: 100, y: 100, frameId: 'f' }] });
  const label = page.locator('[id$="-frame-name-f"]');
  await label.hover();
  const scrollY = () => page.evaluate(() => window.__excalidraw.getAppState().scrollY);
  const before = await scrollY();
  await page.mouse.wheel(0, 40);
  await expect.poll(scrollY).toBe(before - 40);
});
