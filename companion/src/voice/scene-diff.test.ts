import { describe, expect, it } from 'vitest';
import { diffScene, shapeOf, type ExcalidrawLikeElement as El } from './scene-diff';

const el = (id: string, over: Partial<El> = {}): El => ({
  id,
  type: 'rectangle',
  x: 0,
  y: 0,
  width: 10,
  height: 20,
  ...over,
});

describe('diffScene', () => {
  it('emits add for a new element, with its box and default user', () => {
    expect(diffScene([], [el('a', { x: 5, y: 6 })], 100)).toEqual([
      {
        t: 100,
        tEnd: 100,
        elementId: 'a',
        type: 'rectangle',
        bbox: { x: 5, y: 6, width: 10, height: 20 },
        by: 'user',
        kind: 'add',
      },
    ]);
  });

  it('reads Claude from customData and ignores a new deleted element', () => {
    const out = diffScene([], [el('a', { customData: { by: 'claude' } }), el('b', { isDeleted: true })], 0);
    expect(out.map((e) => [e.elementId, e.by])).toEqual([['a', 'claude']]);
  });

  it('emits erase when an element is deleted or disappears, using its old box', () => {
    const prev = [el('a', { x: 3 }), el('b'), el('c')];
    const next = [el('a', { x: 3, isDeleted: true }), el('c')];
    const out = diffScene(prev, next, 5);
    expect(out.map((e) => [e.elementId, e.kind])).toEqual([
      ['a', 'erase'],
      ['b', 'erase'],
    ]);
    expect(out[0].bbox.x).toBe(3);
  });

  it('emits move only past 2 px', () => {
    const prev = [el('a'), el('b'), el('c')];
    const next = [el('a', { x: 2, y: -2 }), el('b', { x: 2.5 }), el('c', { y: 30 })];
    const out = diffScene(prev, next, 0);
    expect(out.map((e) => [e.elementId, e.kind])).toEqual([
      ['b', 'move'],
      ['c', 'move'],
    ]);
  });

  it('emits add when a deleted element comes back', () => {
    const out = diffScene([el('a', { isDeleted: true })], [el('a')], 0);
    expect(out.map((e) => e.kind)).toEqual(['add']);
  });

  it('ignores version bumps and resizes in place', () => {
    const prev = [el('a')];
    const next = [{ ...el('a'), width: 99, version: 4 } as El];
    expect(diffScene(prev, next, 0)).toEqual([]);
    expect(diffScene(prev, prev, 0)).toEqual([]);
  });

  it('folds bound text into its container label and never emits for it', () => {
    const box = el('r');
    const text = el('t', { type: 'text', containerId: 'r', text: 'Header' });
    const added = diffScene([], [box, text], 0);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ elementId: 'r', label: 'Header' });

    // editing the bound text emits nothing
    const edited = el('t', { type: 'text', containerId: 'r', text: 'Footer', x: 50 });
    expect(diffScene([box, text], [box, edited], 0)).toEqual([]);

    // erasing the container carries its old label
    const erased = diffScene([box, text], [{ ...box, isDeleted: true }, { ...text, isDeleted: true }], 0);
    expect(erased).toEqual([expect.objectContaining({ elementId: 'r', kind: 'erase', label: 'Header' })]);
  });

  it('labels free text and frames', () => {
    const out = diffScene([], [el('t', { type: 'text', text: 'hi' }), el('f', { type: 'frame', name: 'Page' })], 0);
    expect(out.map((e) => [e.type, e.label])).toEqual([
      ['text', 'hi'],
      ['frame', 'Page'],
    ]);
  });

  it('skips selection elements', () => {
    expect(diffScene([], [el('s', { type: 'selection' })], 0)).toEqual([]);
  });

  it('maps types', () => {
    expect(shapeOf(el('a', { type: 'freedraw' }))).toBe('freedraw');
    expect(shapeOf(el('a', { type: 'magicframe' }))).toBe('frame');
    expect(shapeOf(el('a', { type: 'image' }))).toBe('rectangle');
    expect(shapeOf(el('a', { customData: { sticky: true } }))).toBe('sticky');
    expect(shapeOf(el('a', { customData: { kind: 'sticky' } }))).toBe('sticky');
    expect(shapeOf(el('a', { customData: { kind: 'other' } }))).toBe('rectangle');
    expect(shapeOf(el('a', { type: 'ellipse', customData: { sticky: true } }))).toBe('ellipse');
  });

  it('handles large scenes quickly', () => {
    const prev = Array.from({ length: 20_000 }, (_, i) => el(`e${i}`));
    const next = [...prev.slice(1), el('new')];
    const t0 = performance.now();
    const out = diffScene(prev, next, 0);
    expect(performance.now() - t0).toBeLessThan(200);
    expect(out.map((e) => e.kind).sort()).toEqual(['add', 'erase']);
  });
});
