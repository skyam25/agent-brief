import { expect, test } from '@playwright/test';
import type { ExcalidrawArrowElement, ExcalidrawElement, ExcalidrawTextElement } from '@excalidraw/excalidraw/element/types';
import type { ReadResponse } from '../src/protocol';
import { backend, launch, sceneElements, showPanel, tempDataDir, type Launched } from './helpers';

let ctx: Launched;

test.beforeAll(async () => {
  ctx = await launch(tempDataDir());
  await showPanel(ctx.app, ctx.page);
});

test.afterAll(async () => {
  await ctx.app.close();
});

/** Each test draws on its own board, shown in the panel. */
async function board(name: string) {
  await backend(ctx.app, 'open', { board: name });
}

const read = async (board = 'current') => {
  const r: ReadResponse = await backend(ctx.app, 'read', board);
  return Object.fromEntries(r.elements.map((e) => [e.id, e]));
};
const scene = async () => {
  const all = await sceneElements(ctx.page);
  return { all, live: all.filter((e) => !e.isDeleted), byId: (id: string) => all.find((e) => e.id === id)! };
};
const labelOf = (all: readonly ExcalidrawElement[], containerId: string) =>
  all.find((e): e is ExcalidrawTextElement => 'containerId' in e && e.containerId === containerId && !e.isDeleted)!;

test('moving a frame moves its children, their labels and the arrows inside', async () => {
  await board('frame-move');
  await backend(ctx.app, 'draw', 'current', {
    elements: [
      { type: 'frame', id: 'f', x: 0, y: 0, width: 600, height: 300, label: 'F' },
      { type: 'rectangle', id: 'r', x: 40, y: 40, label: 'Inside', frameId: 'f' },
      { type: 'ellipse', id: 'e', x: 340, y: 40, frameId: 'f' },
      { type: 'arrow', id: 'a', start: { id: 'r' }, end: { id: 'e' }, frameId: 'f' },
    ],
  });
  const before = await scene();
  const readBefore = await read();
  expect(readBefore.f).toMatchObject({ x: 0, y: 0, width: 600, height: 300 });
  const labelBefore = labelOf(before.all, 'r');
  const res = await backend(ctx.app, 'update', 'current', { updates: [{ id: 'f', x: 100, y: 50 }] });
  expect(res.ids).toEqual(['f']);

  const after = await read();
  expect(after.f).toMatchObject({ x: 100, y: 50 });
  expect(after.r).toMatchObject({ x: 140, y: 90, label: 'Inside' });
  expect(after.e).toMatchObject({ x: 440, y: 90 });
  expect(after.a.x).toBeCloseTo(readBefore.a.x + 100, 0);
  expect(after.a.y).toBeCloseTo(readBefore.a.y + 50, 0);
  const labelAfter = labelOf((await scene()).all, 'r');
  expect(labelAfter.x - labelBefore.x).toBeCloseTo(100, 0);
  expect(labelAfter.y - labelBefore.y).toBeCloseTo(50, 0);
});

test('moving a shape re-routes its bound arrows, which stay bound', async () => {
  await board('reroute');
  await backend(ctx.app, 'draw', 'current', {
    elements: [
      { type: 'rectangle', id: 'a', x: 0, y: 0, width: 100, height: 80 },
      { type: 'rectangle', id: 'b', x: 300, y: 0, width: 100, height: 80 },
      { type: 'arrow', id: 'ab', start: { id: 'a' }, end: { id: 'b' }, label: 'go' },
    ],
  });
  await backend(ctx.app, 'update', 'current', { updates: [{ id: 'b', x: 300, y: 400 }] });
  const r = await read();
  expect(r.ab).toMatchObject({ startId: 'a', endId: 'b', label: 'go' });
  // The arrow now runs down to b's new place and stops just short of it.
  expect(r.ab.y + r.ab.height).toBeGreaterThan(380);
  expect(r.ab.y + r.ab.height).toBeLessThan(400);
  const { byId, all } = await scene();
  expect((byId('ab') as ExcalidrawArrowElement).endBinding!.elementId).toBe('b');
  const label = labelOf(all, 'ab');
  expect(label.y).toBeGreaterThan(100);
});

test('labels: a new label binds text, a long one grows its box, a sticky recolours its fill', async () => {
  await board('labels');
  await backend(ctx.app, 'draw', 'current', {
    elements: [
      { type: 'rectangle', id: 'plain', x: 0, y: 0, width: 160, height: 60 },
      { type: 'sticky', id: 'note', x: 300, y: 0, label: 'Idea' },
    ],
  });
  const long = 'A much longer label that has to wrap over several lines inside this small box';
  await backend(ctx.app, 'update', 'current', {
    updates: [
      { id: 'plain', label: long },
      { id: 'note', color: 'blue' },
    ],
  });
  const r = await read();
  expect(r.plain.label).toBe(long);
  expect(r.plain.height).toBeGreaterThan(60);
  expect(r.note).toMatchObject({ type: 'sticky', color: 'blue', label: 'Idea' });
  const { byId, all } = await scene();
  expect(byId('plain').boundElements!.some((b) => b.type === 'text')).toBe(true);
  expect(labelOf(all, 'plain').containerId).toBe('plain');
  expect(byId('note').backgroundColor).toBe('#a5d8ff');
});

test('deleting a frame deletes what is in it; deleting a shape unbinds its arrows', async () => {
  await board('deletes');
  await backend(ctx.app, 'draw', 'current', {
    elements: [
      { type: 'frame', id: 'f', x: 0, y: 0, width: 400, height: 200 },
      { type: 'rectangle', id: 'in', x: 20, y: 20, label: 'gone soon', frameId: 'f' },
      { type: 'rectangle', id: 'a', x: 0, y: 400 },
      { type: 'rectangle', id: 'b', x: 400, y: 400 },
      { type: 'arrow', id: 'ab', start: { id: 'a' }, end: { id: 'b' } },
    ],
  });
  const res = await backend(ctx.app, 'remove', 'current', { ids: ['f', 'b'] });
  expect(res.ids).toEqual(['f', 'b']);
  const r = await read();
  expect(Object.keys(r).sort()).toEqual(['a', 'ab']);
  expect(r.ab.startId).toBe('a');
  expect(r.ab.endId).toBeUndefined();
  const { byId, all } = await scene();
  expect(byId('in').isDeleted).toBe(true);
  expect(all.filter((e) => 'containerId' in e && e.containerId === 'in').every((e) => e.isDeleted)).toBe(true);
  expect((byId('ab') as ExcalidrawArrowElement).endBinding).toBeNull();
});

test('unknown ids and label ids are left out of the result', async () => {
  await board('unknown');
  await backend(ctx.app, 'draw', 'current', { elements: [{ type: 'rectangle', id: 'r', x: 0, y: 0, label: 'x' }] });
  const labelId = labelOf((await scene()).all, 'r').id;
  const up = await backend(ctx.app, 'update', 'current', { updates: [{ id: 'nope', x: 5 }, { id: labelId, x: 500 }] });
  expect(up.ids).toEqual([]);
  const del = await backend(ctx.app, 'remove', 'current', { ids: ['nope'] });
  expect(del.ids).toEqual([]);
  expect((await read()).r).toMatchObject({ x: 0, label: 'x' });
});

test('an arrow can bind to shapes drawn in earlier batches', async () => {
  await board('batches');
  await backend(ctx.app, 'draw', 'current', { elements: [{ type: 'ellipse', id: 'old', x: 0, y: 0 }] });
  await backend(ctx.app, 'draw', 'current', { elements: [{ type: 'diamond', id: 'older', x: 400, y: 0 }] });
  const res = await backend(ctx.app, 'draw', 'current', { elements: [{ type: 'arrow', id: 'link', start: { id: 'old' }, end: { id: 'older' } }] });
  expect(res.ids).toEqual(['link']);
  expect((await read()).link).toMatchObject({ startId: 'old', endId: 'older' });
  const { byId } = await scene();
  expect(byId('old').boundElements!.map((b) => b.id)).toContain('link');
  expect(byId('older').boundElements!.map((b) => b.id)).toContain('link');
});

test('a draw that refers to a missing id fails as a bad request and changes nothing', async () => {
  await board('bad');
  const before = (await scene()).all.length;
  await expect(
    backend(ctx.app, 'draw', 'current', { elements: [{ type: 'arrow', start: { id: 'ghost' }, end: { x: 1, y: 1 } }] }),
  ).rejects.toThrow(/no element with id "ghost"/);
  expect((await scene()).all.length).toBe(before);
});
