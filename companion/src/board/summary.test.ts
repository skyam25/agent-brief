import { describe, expect, it } from 'vitest';
import { readScene, type SceneElement } from './summary';

const base = { x: 0, y: 0, width: 100, height: 50, strokeColor: '#1e1e1e', backgroundColor: 'transparent' };

const scene: SceneElement[] = [
  { ...base, id: 'f', type: 'frame', name: 'Flow', x: -20, y: -20, width: 600, height: 200, customData: { by: 'claude', batchId: 'b1', createdAt: 5 } },
  { ...base, id: 'r', type: 'rectangle', frameId: 'f', boundElements: [{ id: 't', type: 'text' }, { id: 'a', type: 'arrow' }], customData: { by: 'claude' } },
  { ...base, id: 't', type: 'text', text: 'Start', originalText: 'Start', containerId: 'r', frameId: 'f' },
  { ...base, id: 's', type: 'rectangle', x: 300, backgroundColor: '#ffec99', customData: { by: 'claude', kind: 'sticky' }, boundElements: [{ id: 'a', type: 'arrow' }] },
  { ...base, id: 'a', type: 'arrow', x: 108, y: 25, points: [[0, 0], [184, 0]], strokeColor: '#6741d9', startBinding: { elementId: 'r' }, endBinding: { elementId: 's' } },
  { ...base, id: 'u', type: 'freedraw', x: 1000, y: 1000, points: [[0, 0], [10, 10]] },
  { ...base, id: 'gone', type: 'rectangle', isDeleted: true, x: 5000 },
];

describe('readScene', () => {
  it('summarises live elements with labels, bindings, frames and authors', () => {
    const r = readScene('b', scene);
    expect(r.elements.map((e) => e.id)).toEqual(['f', 'r', 's', 'a', 'u']);
    const byId = Object.fromEntries(r.elements.map((e) => [e.id, e]));
    expect(byId.f).toMatchObject({ type: 'frame', label: 'Flow', by: 'claude', createdAt: 5 });
    expect(byId.r).toMatchObject({ type: 'rectangle', label: 'Start', frameId: 'f', color: 'black', by: 'claude' });
    expect(byId.s).toMatchObject({ type: 'sticky', color: 'yellow' });
    expect(byId.a).toMatchObject({ type: 'arrow', startId: 'r', endId: 's', color: 'violet', x: 108, width: 184 });
    expect(byId.u).toMatchObject({ type: 'freedraw', by: 'user' });
    expect(r.bounds).toEqual({ x: -20, y: -20, width: 1030, height: 1030 });
  });

  it('filters by region intersection but keeps whole-scene bounds', () => {
    const r = readScene('b', scene, { x: 250, y: 0, width: 100, height: 100 });
    expect(r.elements.map((e) => e.id)).toEqual(['f', 's', 'a']);
    expect(r.bounds.width).toBe(1030);
  });

  it('uses first-seen times for user elements', () => {
    const r = readScene('b', scene, undefined, (id) => (id === 'u' ? 42 : undefined));
    expect(r.elements.find((e) => e.id === 'u')?.createdAt).toBe(42);
  });
});
