import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ReadResponse } from '../src/protocol';
import { nextSnapSlot } from './main';
import { fail, pngHeader, useFakeApp } from './testkit';

const { app, run } = useFakeApp();

describe('draw', () => {
  const elements = [
    { id: 'a', type: 'rectangle', x: 0, y: 0, width: 200, height: 80, label: 'A', color: 'blue' },
    { id: 'b', type: 'rectangle', x: 260, y: 0, label: 'B' },
    { type: 'arrow', start: { id: 'a' }, end: { id: 'b' } },
  ];

  beforeEach(() => {
    app.handler = () => ({ json: { ids: ['a', 'b', 'ar'], batchId: 'batch1' } });
  });

  it('accepts {"elements": [...]} on stdin', async () => {
    const r = await run(['draw'], JSON.stringify({ elements }));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('batch1');
    expect(r.stdout).toContain('ids: a b ar');
    expect(app.seen[0]).toEqual({ method: 'POST', url: '/boards/current/draw', body: { elements } });
  });

  it('accepts a bare array', async () => {
    await run(['draw', '--board', 'x'], JSON.stringify(elements));
    expect(app.seen[0].url).toBe('/boards/x/draw');
    expect(app.seen[0].body).toEqual({ elements });
  });

  it('reads --file relative to cwd', async () => {
    fs.writeFileSync(path.join(app.dir, 'd.json'), JSON.stringify(elements));
    const r = await run(['draw', '--file', 'd.json']);
    expect(r.code).toBe(0);
    expect(app.seen[0].body).toEqual({ elements });
  });

  it('names the index of a bad type', async () => {
    const r = await run(['draw'], JSON.stringify([elements[0], { type: 'blob' }]));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('elements[1]');
    expect(r.stderr).toContain('"type"');
    expect(app.seen).toHaveLength(0);
  });

  it('names the index of a bad number, color and endpoint', async () => {
    const bad = async (el: object) => (await run(['draw'], JSON.stringify({ elements: [elements[0], el] }))).stderr;
    expect(await bad({ type: 'text', x: 'left' })).toContain('elements[1]: "x" must be a number');
    expect(await bad({ type: 'text', color: 'teal' })).toContain('elements[1]: unknown color "teal"');
    expect(await bad({ type: 'arrow', start: { id: 'a' }, end: 5 })).toContain('elements[1]: "end"');
    expect(await bad({ type: 'arrow' })).toContain('elements[1]: arrow needs');
    expect(app.seen).toHaveLength(0);
  });

  it('rejects invalid JSON, empty input and wrong shape', async () => {
    expect((await run(['draw'], '{nope')).stderr).toContain('invalid JSON');
    expect((await run(['draw'], '  ')).stderr).toContain('no JSON on stdin');
    expect((await run(['draw'], '{"foo":1}')).stderr).toContain('{"elements"');
    expect((await run(['draw'], '[]')).stderr).toContain('no elements');
    expect(app.seen).toHaveLength(0);
  });

  it('prints server errors with exit 1', async () => {
    app.handler = fail('not_found', 'unknown frame f9', 404);
    const r = await run(['draw'], JSON.stringify(elements));
    expect(r.code).toBe(1);
    expect(r.stderr).toBe('error (not_found): unknown frame f9\n');
  });
});

describe('images', () => {
  beforeEach(() => {
    fs.writeFileSync(path.join(app.dir, 'shot.png'), pngHeader(1440, 900));
    app.handler = () => ({ json: { ids: ['i'], batchId: 'b1' } });
  });

  it('sends an image file as a data URL, sized from a width', async () => {
    const r = await run(['draw'], JSON.stringify([{ type: 'image', file: 'shot.png', x: 0, y: 0, width: 400 }]));
    expect(r.code).toBe(0);
    const [el] = (app.seen[0].body as { elements: Record<string, unknown>[] }).elements;
    expect(el.file).toBeUndefined();
    expect(el.image).toBe(`data:image/png;base64,${pngHeader(1440, 900).toString('base64')}`);
    expect([el.width, el.height]).toEqual([400, 250]);
  });

  it('defaults an image to 720 wide', async () => {
    await run(['draw'], JSON.stringify([{ type: 'image', file: 'shot.png' }]));
    const [el] = (app.seen[0].body as { elements: Record<string, unknown>[] }).elements;
    expect([el.width, el.height]).toEqual([720, 450]);
  });

  it('rejects an image without a file and a file that is not an image', async () => {
    expect((await run(['draw'], '[{"type":"image"}]')).stderr).toContain('elements[0]: image needs "file"');
    fs.writeFileSync(path.join(app.dir, 'notes.txt'), 'hello');
    expect((await run(['draw'], '[{"type":"image","file":"notes.txt"}]')).stderr).toContain('not a png, jpeg, gif or webp');
    expect((await run(['draw'], '[{"type":"image","file":"gone.png"}]')).stderr).toContain('cannot read image gone.png');
    expect(app.seen).toHaveLength(0);
  });

  it('prints one line per new element when the app lists them', async () => {
    app.handler = () => ({
      json: {
        ids: ['a', 'x7k2'],
        batchId: 'b1',
        elements: [
          { id: 'a', type: 'rectangle', x: 0, y: 0, width: 200, height: 86, label: 'Two\nlines', color: 'blue', by: 'claude' },
          { id: 'x7k2', type: 'arrow', x: 0, y: 0, width: 60, height: 0, label: 'ok', startId: 'a', endId: 'b', by: 'claude' },
        ],
      },
    });
    const r = await run(['draw'], '[{"type":"text","label":"x"}]');
    expect(r.stdout).toBe(
      'drew 2 elements, batch b1\na rectangle "Two\\nlines" at 0,0 200×86 blue (claude)\nx7k2 arrow "ok" a → b (claude)\n',
    );
  });

  it('prints warnings from the app', async () => {
    app.handler = () => ({ json: { ids: ['a'], batchId: 'b1', warnings: ['arrow a is 100 px long'] } });
    const r = await run(['draw'], '[{"type":"text","label":"x"}]');
    expect(r.stdout).toContain('warning: arrow a is 100 px long');
  });
});

describe('snap', () => {
  const empty: ReadResponse = { board: 'run', elements: [], bounds: { x: 0, y: 0, width: 0, height: 0 } };

  beforeEach(() => {
    fs.writeFileSync(path.join(app.dir, 'shot.png'), pngHeader(1440, 900));
  });

  it('draws a captioned frame with the picture and a note', async () => {
    app.handler = (req) => (req.method === 'GET' ? { json: empty } : { json: { ids: ['f1', 'i1', 'n1'], batchId: 'b1' } });
    const r = await run(['snap', 'shot.png', '--board', 'run', '--caption', 'Cart', '--note', 'Total is wrong']);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('snapshot 1 at 0,0 · frame f1 · image i1 · note n1\n');
    expect(app.seen[0]).toMatchObject({ method: 'GET', url: '/boards/run/elements' });
    const [frame, image, note] = (app.seen[1].body as { elements: Record<string, unknown>[] }).elements;
    expect(frame).toMatchObject({ type: 'frame', x: 0, y: 0, width: 760, height: 610, label: '1. Cart' });
    expect(image).toMatchObject({ type: 'image', x: 20, y: 20, width: 720, height: 450, frameId: 'snap' });
    expect(note).toMatchObject({ type: 'sticky', y: 490, label: 'Total is wrong', frameId: 'snap' });
  });

  it('needs a file and a positive width', async () => {
    expect((await run(['snap'])).stderr).toContain('snap needs an image file');
    expect((await run(['snap', 'shot.png', '--width', '0'])).stderr).toContain('--width must be a positive integer');
  });
});

describe('nextSnapSlot', () => {
  const frame = (id: string, x: number, y: number, height = 500) =>
    [
      { id, type: 'frame' as const, x, y, width: 760, height, by: 'claude' as const },
      { id: `${id}-img`, type: 'image' as const, x: x + 20, y: y + 20, width: 720, height: 450, by: 'claude' as const, frameId: id },
    ];
  const board = (elements: ReadResponse['elements'], bounds = { x: 0, y: 0, width: 0, height: 0 }): ReadResponse => ({ board: 'b', elements, bounds });

  it('starts at the origin of an empty board, else below what is there', () => {
    expect(nextSnapSlot(board([]))).toEqual({ x: 0, y: 0, step: 1 });
    const sketch = [{ id: 'r', type: 'rectangle' as const, x: 40, y: 10, width: 200, height: 80, by: 'user' as const }];
    expect(nextSnapSlot(board(sketch, { x: 40, y: 10, width: 200, height: 80 }))).toEqual({ x: 40, y: 194, step: 1 });
  });

  it('runs three to a row, then starts a row under the tallest', () => {
    expect(nextSnapSlot(board(frame('a', 0, 0)))).toEqual({ x: 840, y: 0, step: 2 });
    const row = [...frame('a', 0, 0), ...frame('b', 840, 0, 600), ...frame('c', 1680, 0)];
    expect(nextSnapSlot(board(row))).toEqual({ x: 0, y: 704, step: 4 });
  });

  it('ignores frames without a picture of Claude\'s', () => {
    const userFrame = [{ id: 'u', type: 'frame' as const, x: 0, y: 0, width: 400, height: 300, by: 'user' as const }];
    expect(nextSnapSlot(board(userFrame, { x: 0, y: 0, width: 400, height: 300 })).step).toBe(1);
  });
});
