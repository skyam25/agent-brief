import { describe, expect, it, vi } from 'vitest';
import { SyncHub, remoteWins, type HubClient, type HubMessage, type SyncElement } from './sync-hub';

const el = (id: string, version: number, versionNonce = 1, extra: Partial<SyncElement> = {}): SyncElement => ({
  id,
  version,
  versionNonce,
  ...extra,
});

function client(id: string) {
  const messages: HubMessage[] = [];
  const c: HubClient = { id, send: (m) => messages.push(m) };
  return { c, messages };
}

describe('merge rule', () => {
  it('prefers the higher version, then the lower nonce', () => {
    expect(remoteWins(el('a', 1), el('a', 2))).toBe(true);
    expect(remoteWins(el('a', 2), el('a', 1))).toBe(false);
    expect(remoteWins(el('a', 2, 9), el('a', 2, 3))).toBe(true);
    expect(remoteWins(el('a', 2, 3), el('a', 2, 9))).toBe(false);
    expect(remoteWins(el('a', 2, 3), el('a', 2, 3))).toBe(false);
  });
});

describe('SyncHub', () => {
  it('sends a snapshot on join', () => {
    const hub = new SyncHub();
    hub.local('b', [el('a', 1)]);
    const x = client('x');
    hub.join('b', x.c);
    expect(x.messages).toEqual([{ type: 'snapshot', board: 'b', elements: [el('a', 1)] }]);
  });

  it('broadcasts only changed elements to the other clients', () => {
    const hub = new SyncHub();
    const x = client('x');
    const y = client('y');
    hub.join('b', x.c);
    hub.join('b', y.c);
    hub.apply('b', 'x', [el('a', 1), el('c', 1)]);
    x.messages.length = y.messages.length = 0;

    hub.apply('b', 'x', [el('a', 1), el('c', 2)]);
    expect(x.messages).toEqual([]);
    expect(y.messages).toEqual([{ type: 'update', board: 'b', elements: [el('c', 2)] }]);
  });

  it('keeps both of two concurrent edits to different elements', () => {
    const hub = new SyncHub();
    const x = client('x');
    const y = client('y');
    hub.join('b', x.c);
    hub.join('b', y.c);
    hub.apply('b', 'x', [el('p', 1)]);
    hub.apply('b', 'y', [el('q', 1)]);
    expect(hub.snapshot('b').map((e) => e.id).sort()).toEqual(['p', 'q']);
    expect(x.messages.at(-1)).toMatchObject({ elements: [el('q', 1)] });
    expect(y.messages.at(-1)).toMatchObject({ elements: [el('p', 1)] });
  });

  it('breaks version ties with the lower nonce and tells the loser', () => {
    const hub = new SyncHub();
    const x = client('x');
    const y = client('y');
    hub.join('b', x.c);
    hub.join('b', y.c);
    hub.apply('b', 'x', [el('a', 3, 50, { tag: 'x' })]);
    hub.apply('b', 'y', [el('a', 3, 20, { tag: 'y' })]);
    expect(hub.snapshot('b')[0].tag).toBe('y');

    y.messages.length = 0;
    hub.apply('b', 'y', [el('a', 3, 70, { tag: 'late' })]);
    expect(hub.snapshot('b')[0].tag).toBe('y');
    expect(y.messages).toEqual([{ type: 'update', board: 'b', elements: [el('a', 3, 20, { tag: 'y' })] }]);
  });

  it('ignores older versions and identical re-sends', () => {
    const hub = new SyncHub();
    const fn = vi.fn();
    hub.onChange(fn);
    hub.local('b', [el('a', 5)]);
    expect(hub.local('b', [el('a', 4)])).toEqual([]);
    expect(hub.local('b', [el('a', 5)])).toEqual([]);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('carries deletions as tombstones', () => {
    const hub = new SyncHub();
    const x = client('x');
    hub.join('b', x.c);
    hub.local('b', [el('a', 1)]);
    hub.local('b', [el('a', 2, 1, { isDeleted: true })]);
    expect(x.messages.at(-1)).toMatchObject({ elements: [{ id: 'a', isDeleted: true }] });
    expect(hub.snapshot('b')).toHaveLength(1);
    expect(hub.boards()).toEqual([{ name: 'b', elementCount: 0 }]);
    const late = client('late');
    hub.join('b', late.c);
    expect(late.messages[0]).toMatchObject({ elements: [{ id: 'a', isDeleted: true }] });
  });

  it('reports changes with the sender, per board or for all', () => {
    const hub = new SyncHub();
    const all = vi.fn();
    const one = vi.fn();
    hub.onChange(all);
    const off = hub.onChange('b', one);
    hub.local('b', [el('a', 1)]);
    hub.apply('c', 'web-1', [el('z', 1)]);
    expect(all).toHaveBeenCalledTimes(2);
    expect(one).toHaveBeenCalledWith({ board: 'b', from: 'mac', elements: [el('a', 1)] });
    off();
    hub.local('b', [el('a', 2)]);
    expect(one).toHaveBeenCalledTimes(1);
  });

  it('stops sending to a client that left', () => {
    const hub = new SyncHub();
    const x = client('x');
    const leave = hub.join('b', x.c);
    leave();
    x.messages.length = 0;
    hub.local('b', [el('a', 1)]);
    expect(x.messages).toEqual([]);
  });

  it('scales with the changed set, not the board', () => {
    const hub = new SyncHub();
    hub.local('b', Array.from({ length: 50_000 }, (_, i) => el(`e${i}`, 1)));
    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) hub.local('b', [el('e7', i + 2)]);
    expect(performance.now() - t0).toBeLessThan(100);
  });
});

describe('board size', () => {
  const sized = (id: string, version: number, chars: number) => el(id, version, 1, { pad: 'x'.repeat(chars) });

  it('tracks the JSON size of each board as elements change', () => {
    const hub = new SyncHub();
    const a = sized('a', 1, 100);
    hub.local('b', [a]);
    expect(hub.bytes('b')).toBe(JSON.stringify(a).length);
    const a2 = sized('a', 2, 10);
    hub.local('b', [a2, sized('c', 1, 50)]);
    expect(hub.bytes('b')).toBe(JSON.stringify(a2).length + JSON.stringify(sized('c', 1, 50)).length);
    hub.local('b', [sized('a', 1, 5000)]);
    expect(hub.bytes('b')).toBe(JSON.stringify(a2).length + JSON.stringify(sized('c', 1, 50)).length);
    expect(hub.bytes('other')).toBe(0);
  });

  it('says whether a merge fits under a cap, counting only winning elements', () => {
    const hub = new SyncHub();
    hub.local('b', [sized('a', 2, 100)]);
    const now = hub.bytes('b');
    expect(hub.fits('b', [sized('a', 1, 10_000)], now)).toBe(true);
    expect(hub.fits('b', [sized('a', 3, 50)], now)).toBe(true);
    expect(hub.fits('b', [sized('a', 3, 150)], now)).toBe(false);
    expect(hub.fits('b', [sized('n', 1, 10)], now)).toBe(false);
    expect(hub.fits('new', [sized('n', 1, 10)], 1000)).toBe(true);
    expect(hub.fits('b', [sized('n', 1, 10), sized('n', 2, 10)], now + JSON.stringify(sized('n', 2, 10)).length)).toBe(true);
  });
});
