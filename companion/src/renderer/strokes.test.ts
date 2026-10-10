import { describe, expect, it } from 'vitest';
import { StrokeLog, rebase } from './strokes';

const el = (id: string, x = 0, extra: Record<string, unknown> = {}) => ({ id, type: 'freedraw', x, y: 0, width: 10, height: 10, ...extra });

describe('StrokeLog', () => {
  it('records one add per stroke and stretches it while it grows', () => {
    const log = new StrokeLog();
    const growing = el('a');
    log.observe([growing], 1000);
    growing.width = 50;
    log.observe([growing], 1200);
    growing.width = 90;
    log.observe([growing], 1400);
    expect(log.events).toHaveLength(1);
    expect(log.events[0]).toMatchObject({ kind: 'add', t: 1000, tEnd: 1400, bbox: { width: 90 } });
  });

  it('sees moves of elements Excalidraw mutates in place, and merges a drag into one move', () => {
    const shape = el('a');
    const log = new StrokeLog([shape]);
    shape.x = 20;
    log.observe([shape], 5000);
    shape.x = 40;
    log.observe([shape], 5100);
    shape.x = 60;
    log.observe([shape], 5200);
    expect(log.events).toEqual([expect.objectContaining({ kind: 'move', t: 5000, tEnd: 5200, bbox: expect.objectContaining({ x: 60 }) })]);
  });

  it('records erases and Claude additions, and starts over on reset', () => {
    const log = new StrokeLog([el('a')]);
    log.observe([el('a', 0, { isDeleted: true }), el('c', 0, { type: 'rectangle', customData: { by: 'claude' } })], 10);
    expect(log.events.map((e) => [e.kind, e.by])).toEqual([['erase', 'user'], ['add', 'claude']]);
    log.reset([el('c')]);
    expect(log.events).toEqual([]);
  });
});

describe('StrokeLog filter', () => {
  it('drops filtered events but still moves its snapshot on', () => {
    const log = new StrokeLog();
    const claudeOnly = (e: { by: string }) => e.by === 'claude';
    log.observe([el('u'), el('c', 0, { customData: { by: 'claude' } })], 10, claudeOnly);
    expect(log.events.map((e) => e.elementId)).toEqual(['c']);
    log.observe([el('u'), el('c', 0, { customData: { by: 'claude' } })], 20);
    expect(log.events.map((e) => e.elementId)).toEqual(['c']);
  });
});

describe('rebase', () => {
  it('puts the earliest stroke or segment at 0', () => {
    const r = rebase(
      [{ t: 5000, tEnd: 5500, elementId: 'a', type: 'freedraw', bbox: { x: 0, y: 0, width: 1, height: 1 }, by: 'user', kind: 'add' }],
      [{ startedAt: 4000, name: 'seg-0.webm' }],
    );
    expect(r.origin).toBe(4000);
    expect(r.strokes[0]).toMatchObject({ t: 1000, tEnd: 1500 });
    expect(r.segments[0]).toMatchObject({ startMs: 0, name: 'seg-0.webm' });
  });
});
