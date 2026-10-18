import { expect, test } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExcalidrawArrowElement, ExcalidrawElement, ExcalidrawTextElement } from '@excalidraw/excalidraw/element/types';
import type { ReadResponse } from '../src/protocol';
import { backend, FLOW, launch, RESULTS, sceneElements, showPanel, tempDataDir, type Launched } from './helpers';

let ctx: Launched;
let dataDir: string;

test.beforeAll(async () => {
  dataDir = tempDataDir();
  ctx = await launch(dataDir);
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

function pngSize(b64: string): { width: number; height: number; bytes: Buffer } {
  const bytes = Buffer.from(b64, 'base64');
  expect(bytes.subarray(1, 4).toString()).toBe('PNG');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), bytes };
}

test('C4.3 png of a region keeps the long edge at 1400 or less', async () => {
  await board('png-region');
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

/** A solid-colour PNG made in the renderer, as a data URL. */
function solidPng(width: number, height: number, color: string): Promise<string> {
  return ctx.page.evaluate(
    ({ width, height, color }) => {
      const c = document.createElement('canvas');
      c.width = width;
      c.height = height;
      const g = c.getContext('2d')!;
      g.fillStyle = color;
      g.fillRect(0, 0, width, height);
      return c.toDataURL('image/png');
    },
    { width, height, color },
  );
}

/** The RGB of one pixel of a base64 PNG, decoded in the renderer. */
function pixel(b64: string, x: number, y: number): Promise<number[]> {
  return ctx.page.evaluate(
    async ({ b64, x, y }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      const g = c.getContext('2d')!;
      g.drawImage(img, 0, 0);
      return Array.from(g.getImageData(x, y, 1, 1).data.slice(0, 3));
    },
    { b64, x, y },
  );
}

test('an image in a frame draws, saves with its file, reads back and renders', async () => {
  await board('image-frame');
  const { app, page } = ctx;
  const image = await solidPng(400, 250, '#ff0000');
  const drawn = await backend(app, 'draw', 'current', {
    elements: [
      { type: 'frame', id: 'snap', x: 0, y: 0, width: 440, height: 290, label: '1. Cart' },
      { type: 'image', id: 'shot', x: 20, y: 20, width: 400, height: 250, image, frameId: 'snap' },
    ],
  });
  expect(drawn.ids).toEqual(['snap', 'shot']);

  const el = (await scene()).live.find((e) => e.id === 'shot');
  expect(el).toMatchObject({ type: 'image', status: 'saved', fileId: 'file-shot', frameId: 'snap' });
  expect(await page.evaluate(() => Object.keys(window.__excalidraw.getFiles()))).toContain('file-shot');

  const read: ReadResponse = await backend(app, 'read', 'current');
  expect(read.elements.find((e) => e.id === 'shot')).toMatchObject({ type: 'image', frameId: 'snap', by: 'claude' });

  const png = await backend(app, 'png', 'current', { region: { x: 0, y: 0, width: 440, height: 290 }, maxEdge: 440 });
  expect(await pixel(png.base64, 220, 145)).toEqual([255, 0, 0]);
  writeFileSync(join(RESULTS, 'image-board.png'), Buffer.from(png.base64, 'base64'));

  await expect
    .poll(() => {
      const file = JSON.parse(readFileSync(join(dataDir, 'boards', 'image-frame.excalidraw'), 'utf8'));
      return file.files?.['file-shot']?.dataURL?.slice(0, 22);
    })
    .toBe('data:image/png;base64,');
});

test('an image on a board out of view is saved to disk with its file', async () => {
  const { app } = ctx;
  const image = await solidPng(200, 100, '#0000ff');
  await backend(app, 'draw', 'run', { elements: [{ type: 'image', id: 'pic', x: 0, y: 0, width: 200, height: 100, image }] });
  const file = JSON.parse(readFileSync(join(dataDir, 'boards', 'run.excalidraw'), 'utf8'));
  expect(file.files['file-pic'].mimeType).toBe('image/png');
  const png = await backend(app, 'png', 'run', { maxEdge: 200 });
  expect(await pixel(png.base64, 100, 50)).toEqual([0, 0, 255]);
});

test('a large screenshot is scaled down to 1600 px before it is stored', async () => {
  await board('image-large');
  const { app, page } = ctx;
  const image = await solidPng(3200, 2000, '#00ff00');
  await backend(app, 'draw', 'current', { elements: [{ type: 'image', id: 'big', x: 0, y: 0, width: 720, height: 450, image }] });
  const size = await page.evaluate(async () => {
    const f = window.__excalidraw.getFiles()['file-big'];
    const img = new Image();
    img.src = f.dataURL;
    await img.decode();
    return { width: img.naturalWidth, height: img.naturalHeight, mimeType: f.mimeType };
  });
  expect(size).toEqual({ width: 1600, height: 1000, mimeType: 'image/webp' });
});

test('draw warns when an arrow label hides the arrow', async () => {
  await board('arrow-label');
  const { app } = ctx;
  const drawn = await backend(app, 'draw', 'current', {
    elements: [
      { id: 'a', type: 'rectangle', x: 0, y: 0, width: 200, height: 80, label: 'Browser' },
      { id: 'b', type: 'rectangle', x: 300, y: 0, width: 200, height: 80, label: 'API' },
      { id: 'c', type: 'rectangle', x: 900, y: 0, width: 200, height: 80, label: 'DB' },
      { id: 'near', type: 'arrow', start: { id: 'a' }, end: { id: 'b' }, label: 'POST /login with password' },
      { id: 'far', type: 'arrow', start: { id: 'b' }, end: { id: 'c' }, label: 'lookup' },
    ],
  });
  expect(drawn.warnings).toHaveLength(1);
  expect(drawn.warnings![0]).toMatch(/^arrow near is \d+ px long, so its label "POST \/login with password" hides it/);
});

test('draw lists its elements, and draw and update warn when a box grows over its neighbour', async () => {
  await board('grown-box');
  const { app } = ctx;
  const drawn = await backend(app, 'draw', 'current', {
    elements: [
      { id: 'top', type: 'rectangle', x: 0, y: 0, width: 380, height: 60, label: 'First line of the label\nSecond line' },
      { id: 'next', type: 'rectangle', x: 0, y: 70, width: 380, height: 60, label: 'Next' },
      { id: 'fits', type: 'rectangle', x: 500, y: 0, width: 380, height: 100, label: 'First line of the label\nSecond line' },
      { id: 'clear', type: 'rectangle', x: 500, y: 160, width: 380, height: 100, label: 'Next' },
      // Free text has no planned box, so text over a shape never reads as grown.
      { id: 'caption', type: 'text', x: 1000, y: 0, label: 'Caption over a box' },
      { id: 'under', type: 'rectangle', x: 1000, y: 5, width: 300, height: 60 },
    ],
  });
  expect(drawn.elements?.map((e) => e.id)).toEqual(['top', 'next', 'fits', 'clear', 'caption', 'under']);
  expect(drawn.elements?.[0]).toMatchObject({ type: 'rectangle', height: 86, label: 'First line of the label\nSecond line', by: 'claude' });
  expect(drawn.warnings).toEqual([
    'rectangle top grew from 60 to 86 px tall to hold its label and now overlaps next. Move it down at least 36 px with update, or give top more width.',
  ]);

  const updated = await backend(app, 'update', 'current', { updates: [{ id: 'fits', label: 'One\nTwo\nThree\nFour\nFive\nSix' }] });
  expect(updated.warnings).toEqual([
    'rectangle fits grew from 100 to 194 px tall to hold its label and now overlaps clear. Move it down at least 54 px with update, or give fits more width.',
  ]);
});

test('a label keeps its padding, the box grows to hold it, and its frame grows too', async () => {
  await board('label-padding');
  const { app } = ctx;
  const note = 'AUGUST (Ahmed, first time)\nConfig entries named and bolded inconsistently (Erin)\nNot written in complete human sentences (Leia)';
  const list = 'SEPTEMBER (Aaron)\n- Looking much better this round (Erin)\n- One item had no description (Felipe)';
  const drawn = await backend(app, 'draw', 'current', {
    elements: [
      { id: 'f', type: 'frame', x: 0, y: 0, width: 700, height: 160, label: 'Reviewers' },
      { id: 'a', type: 'sticky', x: 40, y: 40, width: 300, height: 80, label: note, frameId: 'f' },
      { id: 'b', type: 'sticky', x: 360, y: 40, width: 300, height: 80, label: list, frameId: 'f' },
      { id: 'g', type: 'frame', x: 0, y: 200, width: 700, height: 100, label: 'Next' },
    ],
  });
  const { live: shown } = await scene();
  const el = (id: string) => shown.find((e) => e.id === id)!;
  type Label = { containerId?: string | null; textAlign: string; x: number; y: number; width: number; height: number };
  const labelFor = (id: string) => (shown as unknown as Label[]).find((e) => e.containerId === id)!;
  for (const id of ['a', 'b']) {
    const box = el(id);
    const text = labelFor(id);
    expect(text.x - box.x).toBeGreaterThanOrEqual(16);
    expect(box.x + box.width - (text.x + text.width)).toBeGreaterThanOrEqual(15);
    expect(text.y - box.y).toBeGreaterThanOrEqual(15);
    expect(box.y + box.height - (text.y + text.height)).toBeGreaterThanOrEqual(15);
  }
  expect(el('a').height).toBeGreaterThan(80);
  // Each wrapped line fits the label as the board's font draws it, so nothing runs past the box.
  const { page } = ctx;
  for (const id of ['a', 'b']) {
    const text = labelFor(id) as Label & { text: string; fontSize: number };
    const widest = await page.evaluate(async ({ lines, size }) => {
      await document.fonts.load(`${size}px Nunito`);
      const c = document.createElement('canvas').getContext('2d')!;
      c.font = `${size}px Nunito`;
      return Math.max(...lines.map((l) => c.measureText(l).width));
    }, { lines: text.text.split('\n'), size: text.fontSize });
    expect(widest).toBeLessThanOrEqual(text.width + 1);
  }
  // A label with list lines lines up left, the rest center.
  expect(labelFor('a').textAlign).toBe('center');
  expect(labelFor('b').textAlign).toBe('left');
  // The frame grew to hold the taller notes, and says what it now overlaps.
  const frame = el('f');
  expect(frame.y + frame.height).toBeGreaterThanOrEqual(Math.max(el('a').y + el('a').height, el('b').y + el('b').height));
  expect(drawn.warnings?.some((w) => /^frame f grew to 700×\d+ to hold its contents and now overlaps g\. Move it down at least \d+ px with update\. A frame moves with everything in it\.$/.test(w))).toBe(true);
  // The stickies sit in f, so the frame's warning speaks for them.
  expect(drawn.warnings).toHaveLength(1);
});
