import { describe, expect, it } from 'vitest';
import type { Skeleton } from '../protocol';
import type { Shaped } from './geometry';
import { PALETTE, TEXT_COLOR, TEXT_FONT } from './palette';
import { endOf, labelAlign, linearGeometry, planDraw, type PlanContext } from './skeleton';

function ctx(existing: Record<string, Shaped> = {}, sceneBounds = { x: 0, y: 0, width: 0, height: 0 }): PlanContext {
  let n = 0;
  return { existing: new Map(Object.entries(existing)), sceneBounds, newId: () => `gen${++n}` };
}

describe('labelAlign', () => {
  it('lines up a list left and the rest center, unless the caller says', () => {
    expect(labelAlign('Login')).toBe('center');
    expect(labelAlign('Title\n- one\n- two')).toBe('left');
    expect(labelAlign('Title\n• one')).toBe('left');
    expect(labelAlign('a - b')).toBe('center');
    expect(labelAlign('Title\n- one', 'center')).toBe('center');
    expect(labelAlign('Login', 'left')).toBe('left');
  });
});

describe('planDraw', () => {
  it('plans an image with its file, inside a frame', () => {
    const image = 'data:image/png;base64,AAAA';
    const plan = planDraw(
      [
        { type: 'frame', id: 'f', x: 0, y: 0, width: 760, height: 490 },
        { type: 'image', id: 'shot', x: 20, y: 20, width: 720, height: 450, image, frameId: 'f' },
      ],
      ctx(),
    );
    expect(plan.files).toEqual([{ id: 'file-shot', dataURL: image, mimeType: 'image/png' }]);
    expect(plan.shapes[0]).toMatchObject({
      id: 'shot',
      frameId: 'f',
      skel: { type: 'image', fileId: 'file-shot', status: 'saved', width: 720, height: 450 },
    });
  });

  it('rejects an image without a data URL or a size', () => {
    expect(() => planDraw([{ type: 'image', width: 10, height: 10 }], ctx())).toThrow(/data URL/);
    expect(() => planDraw([{ type: 'image', image: 'data:image/png;base64,AAAA' }], ctx())).toThrow(/width and height/);
  });

  it('keeps caller ids and returns ids in request order', () => {
    const plan = planDraw(
      [
        { type: 'rectangle', id: 'a', x: 0, y: 0, label: 'A' },
        { type: 'ellipse', x: 300, y: 0 },
        { type: 'arrow', id: 'link', start: { id: 'a' }, end: { x: 500, y: 40 } },
      ],
      ctx(),
    );
    expect(plan.ids).toEqual(['a', 'gen1', 'link']);
    expect(plan.shapes.map((s) => s.id)).toEqual(['a', 'gen1']);
    expect(plan.linear[0]).toMatchObject({ id: 'link', start: { id: 'a' }, end: { point: [500, 40] } });
  });

  it('remaps ids that clash with the board and follows the remap in references', () => {
    const plan = planDraw(
      [
        { type: 'rectangle', id: 'a', x: 0, y: 0 },
        { type: 'arrow', start: { id: 'a' }, end: { id: 'old' } },
      ],
      ctx({ a: { type: 'rectangle', x: 0, y: 0, width: 1, height: 1 }, old: { type: 'ellipse', x: 0, y: 0, width: 1, height: 1 } }),
    );
    expect(plan.ids[0]).toBe('gen1');
    expect(plan.linear[0].start).toEqual({ id: 'gen1' });
    expect(plan.linear[0].end).toEqual({ id: 'old' });
  });

  it('turns a sticky into a filled yellow rectangle with dark text', () => {
    const { shapes } = planDraw([{ type: 'sticky', x: 0, y: 0, label: 'Idea' }], ctx());
    expect(shapes[0].sticky).toBe(true);
    expect(shapes[0].skel).toMatchObject({
      type: 'rectangle',
      backgroundColor: PALETTE.yellow.fill,
      fillStyle: 'solid',
      label: { text: 'Idea', strokeColor: PALETTE.black.stroke },
    });
  });

  it('draws shapes in violet and text in a neutral sans font', () => {
    const { shapes, linear } = planDraw(
      [
        { type: 'diamond', x: 0, y: 0, color: 'green', label: 'go' },
        { type: 'text', x: 0, y: 0, label: 'hi' },
        { type: 'text', x: 0, y: 0, label: 'warn', color: 'red' },
        { type: 'rectangle', x: 0, y: 0 },
        { type: 'line', x: 0, y: 0, points: [[0, 0], [50, 20]] },
      ],
      ctx(),
    );
    expect(shapes[0].skel).toMatchObject({ strokeColor: PALETTE.green.stroke, label: { strokeColor: TEXT_COLOR, fontFamily: TEXT_FONT } });
    expect(shapes[1].skel).toMatchObject({ type: 'text', text: 'hi', strokeColor: TEXT_COLOR, fontFamily: TEXT_FONT });
    expect(shapes[2].skel).toMatchObject({ strokeColor: PALETTE.red.stroke, fontFamily: TEXT_FONT });
    expect(shapes[3].skel.strokeColor).toBe(PALETTE.violet.stroke);
    expect(linear[0].skel).toMatchObject({ x: 0, y: 0, points: [[0, 0], [50, 20]], strokeColor: PALETTE.violet.stroke });
  });

  it('places elements without a position to the right of the board', () => {
    const { shapes } = planDraw(
      [{ type: 'rectangle' }, { type: 'rectangle', width: 100 }],
      ctx({}, { x: 10, y: 20, width: 500, height: 300 }),
    );
    expect(shapes[0].skel).toMatchObject({ x: 590, y: 20, width: 180, height: 80 });
    expect(shapes[1].skel).toMatchObject({ x: 590 + 180 + 60, y: 20 });
  });

  it('collects frame children from frameId, for new and existing frames', () => {
    const plan = planDraw(
      [
        { type: 'frame', id: 'f', label: 'Flow' },
        { type: 'rectangle', id: 'r', x: 0, y: 0, frameId: 'f' },
        { type: 'text', x: 0, y: 0, label: 't', frameId: 'oldFrame' },
      ],
      ctx({ oldFrame: { type: 'frame', x: 0, y: 0, width: 400, height: 400 } }),
    );
    expect(plan.frames).toEqual([{ id: 'f', skel: { type: 'frame', id: 'f', children: [], name: 'Flow' }, placed: false }]);
    expect(plan.shapes.map((s) => s.frameId)).toEqual(['f', 'oldFrame']);
  });

  it('sizes an empty frame without geometry and treats deleted ids as taken', () => {
    const plan = planDraw([{ type: 'frame', id: 'gone' }], { ...ctx(), taken: (id) => id === 'gone' });
    expect(plan.ids).toEqual(['gen1']);
    expect(plan.frames[0]).toMatchObject({ placed: true, skel: { x: 0, y: 0, width: 400, height: 300 } });
  });

  it('rejects unknown types, missing references and non-frame parents', () => {
    expect(() => planDraw([{ type: 'blob' } as unknown as Skeleton], ctx())).toThrow(/unknown type/);
    expect(() => planDraw([{ type: 'arrow', start: { id: 'nope' }, end: { x: 1, y: 1 } }], ctx())).toThrow(/no element/);
    expect(() => planDraw([{ type: 'rectangle', id: 'r', x: 0, y: 0 }, { type: 'text', label: 'x', frameId: 'r' }], ctx()))
      .toThrow(/not a frame/);
    try {
      planDraw([{ type: 'blob' } as unknown as Skeleton], ctx());
    } catch (err) {
      expect((err as { code?: string }).code).toBe('bad_request');
    }
  });

  it('gives a one-ended arrow a free end beside its shape', () => {
    const shape = { type: 'rectangle', x: 0, y: 0, width: 100, height: 50 };
    const plan = planDraw([{ type: 'arrow', start: { id: 's' }, width: 80 }], ctx({ s: shape }));
    expect(plan.linear[0].end).toEqual({ beside: 's', delta: [80, 0] });
    const end = endOf(plan.linear[0].end, () => shape);
    expect(end).toEqual({ point: [180, 25] });
  });
});

describe('linearGeometry', () => {
  it('starts at the first end and points at the second', () => {
    const a = { type: 'rectangle', x: 0, y: 0, width: 100, height: 100 };
    const b = { type: 'rectangle', x: 300, y: 0, width: 100, height: 100 };
    expect(linearGeometry({ shape: a }, { shape: b })).toEqual({ x: 108, y: 50, points: [[0, 0], [184, 0]] });
  });
});
