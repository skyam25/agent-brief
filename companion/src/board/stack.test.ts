import { describe, expect, it } from 'vitest';
import { CELL, fitCell, planStack, stackNames, type StackElement, type StackPlan } from './stack';

const image = (id: string, x: number, y: number, extra: Partial<StackElement> = {}): StackElement => ({
  id,
  type: 'image',
  x,
  y,
  width: 200,
  height: 100,
  ...extra,
});

let made = 0;
/** Frame ids, unique across a test file like the random ids the app uses. */
const ids = () => () => `g${++made}`;

/** The scene after the plan, as plain records. */
function apply(elements: StackElement[], plan: StackPlan): StackElement[] {
  const next = elements.map((e) => ({ ...e, ...plan.patches.get(e.id) }));
  return [...next, ...plan.frames.map((f) => ({ ...f, type: 'frame' }))];
}

function settle(elements: StackElement[], arrival?: { ids: string[]; join?: string }) {
  const newId = ids();
  const once = apply(elements, planStack(elements, { arrival, newId }));
  return once;
}

const frames = (els: StackElement[]) => els.filter((e) => e.type === 'frame' && !e.isDeleted).sort((a, b) => a.y - b.y);
const live = (els: StackElement[], id: string) => els.find((e) => e.id === id)!;

describe('fitCell', () => {
  it('scales large pictures into the cell and keeps small ones', () => {
    expect(fitCell(2880, 1800)).toEqual({ width: CELL.width, height: 300 });
    expect(fitCell(200, 100)).toEqual({ width: 200, height: 100 });
  });
});

describe('planStack', () => {
  it('gives each loose screenshot its own numbered group, top to bottom', () => {
    const out = settle([image('a', 900, 900), image('b', -400, 50)]);
    const fs = frames(out);
    expect(fs.map((f) => f.name)).toEqual(['1', '2']);
    expect(live(out, 'a').frameId).toBe(fs[0].id);
    expect(live(out, 'b').frameId).toBe(fs[1].id);
    expect(fs[1].y).toBeGreaterThan(fs[0].y + fs[0].height);
  });

  it('puts one drop of several pictures into one group, side by side', () => {
    const out = settle([image('a', 0, 0), image('b', 0, 0), image('c', 0, 0), image('d', 0, 0)], { ids: ['a', 'b', 'c', 'd'] });
    expect(frames(out)).toHaveLength(1);
    const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((id) => live(out, id));
    expect(a.y).toBe(b.y);
    expect(b.x).toBeGreaterThan(a.x);
    expect(c.x).toBeGreaterThan(b.x);
    // The fourth wraps to a new row.
    expect(d.x).toBe(a.x);
    expect(d.y).toBeGreaterThan(a.y);
  });

  it('adds an arrival to the group it joins', () => {
    const first = settle([image('a', 0, 0)]);
    const group = frames(first)[0].id;
    const out = settle([...first, image('b', 2000, 2000)], { ids: ['b'], join: group });
    expect(frames(out)).toHaveLength(1);
    expect(live(out, 'b').frameId).toBe(group);
  });

  it('is stable once laid out', () => {
    const out = settle([image('a', 0, 0), image('b', 500, 500)]);
    const again = planStack(out, { newId: ids() });
    expect(again.patches.size).toBe(0);
    expect(again.frames).toHaveLength(0);
  });

  it('moves a picture dropped on another group into it, and drops the empty frame', () => {
    const out = settle([image('a', 0, 0), image('b', 500, 500)]);
    const [one, two] = frames(out);
    const b = live(out, 'b');
    // Drag b over group 1.
    const dragged = out.map((e) => (e.id === 'b' ? { ...b, x: one.x + 10, y: one.y + 10 } : e));
    const plan = planStack(dragged, { newId: ids() });
    expect(plan.patches.get('b')?.frameId).toBe(one.id);
    expect(plan.patches.get(two.id)?.isDeleted).toBe(true);
  });

  it('splits a picture dragged out to empty space into a new group at the end', () => {
    const out = settle([image('a', 0, 0), image('b', 0, 0)], { ids: ['a', 'b'] });
    const b = live(out, 'b');
    const dragged = out.map((e) => (e.id === 'b' ? { ...b, x: 3000, y: 3000 } : e));
    const next = settle(dragged);
    const fs = frames(next);
    expect(fs.map((f) => f.name)).toEqual(['1', '2']);
    expect(live(next, 'b').frameId).toBe(fs[1].id);
  });

  it('moves marks drawn on a screenshot with it', () => {
    const out = settle([image('a', 0, 0), image('b', 0, 0)], { ids: ['a', 'b'] });
    const b = live(out, 'b');
    const mark: StackElement = { id: 'm', type: 'freedraw', x: b.x + 20, y: b.y + 20, width: 30, height: 30, frameId: b.frameId };
    // Drag b and its mark out together.
    const dragged = [...out.map((e) => (e.id === 'b' ? { ...b, x: 3000, y: 3000 } : e)), { ...mark, x: 3020, y: 3020 }];
    const next = settle(dragged);
    const nb = live(next, 'b');
    expect(live(next, 'm').x).toBeCloseTo(nb.x + 20);
    expect(live(next, 'm').frameId).toBe(nb.frameId);
  });

  it('leaves pictures inside other frames alone', () => {
    const step: StackElement = { id: 'f', type: 'frame', x: 1000, y: 0, width: 400, height: 300 };
    const plan = planStack([step, image('a', 1050, 50, { frameId: 'f' })], { newId: ids() });
    expect(plan.patches.size).toBe(0);
    expect(plan.frames).toHaveLength(0);
  });
});

describe('stackNames', () => {
  it('numbers groups and letters pictures that share one', () => {
    const out = settle([image('a', 0, 0)]);
    const next = settle([...out, image('b', 0, 0), image('c', 0, 0)], { ids: ['b', 'c'] });
    expect(stackNames(next)).toEqual({ a: '1', b: '2a', c: '2b' });
  });
});
