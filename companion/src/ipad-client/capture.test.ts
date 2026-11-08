import { describe, expect, it } from 'vitest';
import type { StrokeEvent } from '../voice/types';
import { deliveryOf, onOneClock, toBase64 } from './capture';

const stroke = (t: number, tEnd = t + 50): StrokeEvent => ({
  t,
  tEnd,
  elementId: `e${t}`,
  type: 'freedraw',
  bbox: { x: 0, y: 0, width: 10, height: 10 },
  by: 'user',
  kind: 'add',
});

describe('onOneClock', () => {
  it('leaves strokes alone when the first stroke came before any speech', () => {
    const out = onOneClock([stroke(0), stroke(900)], 10_000, [{ t: 10_500, tEnd: 11_000, text: 'here' }]);
    expect(out.strokes.map((s) => s.t)).toEqual([0, 900]);
    expect(out.utterances).toEqual([{ t: 500, tEnd: 1000, text: 'here' }]);
  });

  it('shifts strokes forward when speech came first', () => {
    const out = onOneClock([stroke(0)], 10_000, [{ t: 8000, tEnd: 9000, text: 'first' }]);
    expect(out.strokes[0]).toMatchObject({ t: 2000, tEnd: 2050 });
    expect(out.utterances[0]).toMatchObject({ t: 0, tEnd: 1000 });
  });

  it('starts speech at 0 with no strokes', () => {
    const out = onOneClock([], undefined, [{ t: 5000, tEnd: 5400, text: 'only' }]);
    expect(out).toEqual({ strokes: [], utterances: [{ t: 0, tEnd: 400, text: 'only' }] });
  });

  it('starts strokes at 0 with no speech', () => {
    expect(onOneClock([stroke(0)], 7000, []).strokes[0].t).toBe(0);
  });

  it('never ends a phrase before it starts', () => {
    expect(onOneClock([], undefined, [{ t: 100, tEnd: 50, text: 'x' }]).utterances[0]).toMatchObject({ t: 0, tEnd: 0 });
  });
});

describe('deliveryOf', () => {
  it('encodes the picture and keeps the scene and bounds', () => {
    const bounds = { x: 1, y: 2, width: 3, height: 4 };
    const out = deliveryOf({ boardName: 'a', png: new Uint8Array([1, 2, 3]), scene: { elements: [] }, strokes: [], bounds }, undefined, [], 'a');
    expect(out).toEqual({ pngBase64: 'AQID', scene: { elements: [] }, bounds, strokes: [], utterances: [] });
  });

  it('carries the note, and leaves out a blank one', () => {
    const payload = { boardName: 'a', png: new Uint8Array(), scene: {}, strokes: [], bounds: { x: 0, y: 0, width: 0, height: 0 } };
    expect(deliveryOf({ ...payload, notes: 'Use the blue' }, undefined, [], 'a').notes).toBe('Use the blue');
    expect(deliveryOf({ ...payload, notes: '  ' }, undefined, [], 'a')).not.toHaveProperty('notes');
  });

  it('refuses a canvas that holds another board', () => {
    const payload = { boardName: 'b', png: new Uint8Array(), scene: {}, strokes: [], bounds: { x: 0, y: 0, width: 0, height: 0 } };
    expect(() => deliveryOf(payload, undefined, [], 'a')).toThrow('not the one being sent');
  });

  it('encodes pictures larger than one chunk', () => {
    const bytes = new Uint8Array(0x10001).fill(65);
    expect(atob(toBase64(bytes))).toBe('A'.repeat(0x10001));
  });
});
