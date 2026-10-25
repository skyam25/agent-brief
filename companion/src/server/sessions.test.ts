import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionInfo } from '../protocol';
import { closeServers, start, startModed, startTracked } from './server-testkit';

afterEach(closeServers);

describe('sessions', () => {
  it('registers, lists and removes', async () => {
    const h = await start();
    const host = { terminal: 'ghostty', bundleId: 'com.mitchellh.ghostty', herdrPane: 'w1:p2' };
    const reg = await h.call('POST', '/sessions', { sessionId: 'a', cwd: '/x', title: 'T', pid: 7, summary: 'fix the header', host });
    expect(reg.status).toBe(200);
    const list = await h.call('GET', '/sessions');
    expect(list.body).toEqual({
      sessions: [
        {
          sessionId: 'a',
          cwd: '/x',
          title: 'T',
          pid: 7,
          summary: 'fix the header',
          host,
          lastSeen: h.clock.t,
          outputsPath: '/x/.feedback/outputs/a.json',
        },
      ],
    });
    const del = await h.call('DELETE', '/sessions/a');
    expect(del.body).toEqual({ removed: true });
    expect((await h.call('GET', '/sessions')).body).toEqual({ sessions: [] });
  });

  it('refreshes lastSeen on re-register and on poll', async () => {
    const h = await start();
    await h.call('POST', '/sessions', { sessionId: 'a', cwd: '/x' });
    h.clock.t += 60_000;
    await h.call('GET', '/deliveries?session=a&wait=0');
    h.clock.t += 60_000;
    expect(h.server.sessions().sessions).toHaveLength(1);
    await h.call('POST', '/sessions', { sessionId: 'a', cwd: '/x' });
    h.clock.t += 89_000;
    expect(h.server.sessions().sessions[0].lastSeen).toBe(h.clock.t - 89_000);
    expect(h.server.sessions().sessions).toHaveLength(1);
  });

  it('expires sessions unseen for 90 s', async () => {
    const h = await start();
    await h.call('POST', '/sessions', { sessionId: 'a', cwd: '/x' });
    h.clock.t += 89_999;
    expect(h.server.sessions().sessions).toHaveLength(1);
    h.clock.t += 2;
    expect(h.server.sessions().sessions).toHaveLength(0);
    expect(h.server.sessions().targetSessionId).toBeUndefined();
  });

  describe('target', () => {
    it('is never picked by registering', async () => {
      const h = await start();
      await h.call('POST', '/sessions', { sessionId: 'a', cwd: '/x' });
      await h.call('POST', '/sessions', { sessionId: 'b', cwd: '/y' });
      expect(h.server.sessions().targetSessionId).toBeUndefined();
    });

    it('follows setTarget and rejects unknown ids', async () => {
      const h = await start();
      await h.call('POST', '/sessions', { sessionId: 'a', cwd: '/x' });
      await h.call('POST', '/sessions', { sessionId: 'b', cwd: '/y' });
      h.server.setTarget('b');
      expect(h.server.sessions().targetSessionId).toBe('b');
      expect(() => h.server.setTarget('zzz')).toThrow(/unknown session/);
      h.server.setTarget(undefined);
      expect(h.server.sessions().targetSessionId).toBeUndefined();
    });

    it('clears when the target leaves, without picking another', async () => {
      const h = await start();
      await h.call('POST', '/sessions', { sessionId: 'a', cwd: '/x' });
      await h.call('POST', '/sessions', { sessionId: 'b', cwd: '/y' });
      h.server.setTarget('a');
      await h.call('DELETE', '/sessions/a');
      expect(h.server.sessions().targetSessionId).toBeUndefined();
    });

    it('clears when the target expires', async () => {
      const h = await start();
      await h.call('POST', '/sessions', { sessionId: 'a', cwd: '/x' });
      h.server.setTarget('a');
      h.clock.t += 80_000;
      await h.call('POST', '/sessions', { sessionId: 'b', cwd: '/y' });
      h.clock.t += 20_000;
      expect(h.server.sessions().sessions.map((s) => s.sessionId)).toEqual(['b']);
      expect(h.server.sessions().targetSessionId).toBeUndefined();
    });

    it('comes back when the lapsed target registers again', async () => {
      const h = await start();
      await h.call('POST', '/sessions', { sessionId: 'a', cwd: '/x' });
      await h.call('POST', '/sessions', { sessionId: 'b', cwd: '/y' });
      h.server.setTarget('a');
      h.clock.t += 100_000;
      expect(h.server.sessions().targetSessionId).toBeUndefined();
      await h.call('POST', '/sessions', { sessionId: 'b', cwd: '/y' });
      expect(h.server.sessions().targetSessionId).toBeUndefined();
      await h.call('POST', '/sessions', { sessionId: 'a', cwd: '/x' });
      expect(h.server.sessions().targetSessionId).toBe('a');
    });

    it('stays clear after a lapse when the user cleared it or the session ended', async () => {
      const h = await start();
      await h.call('POST', '/sessions', { sessionId: 'a', cwd: '/x' });
      h.server.setTarget('a');
      h.clock.t += 100_000;
      h.server.sessions();
      h.server.setTarget(undefined);
      await h.call('POST', '/sessions', { sessionId: 'a', cwd: '/x' });
      expect(h.server.sessions().targetSessionId).toBeUndefined();

      h.server.setTarget('a');
      await h.call('DELETE', '/sessions/a');
      await h.call('POST', '/sessions', { sessionId: 'a', cwd: '/x' });
      expect(h.server.sessions().targetSessionId).toBeUndefined();
    });
  });

  it('keeps activeAt and reports a change in it', async () => {
    const h = await start();
    const seen: number[] = [];
    h.server.onSessionsChange((s) => seen.push(s.sessions[0]?.activeAt ?? 0));
    await h.call('POST', '/sessions', { sessionId: 'a', cwd: '/x', activeAt: 5 });
    await h.call('POST', '/sessions', { sessionId: 'a', cwd: '/x', activeAt: 5 });
    await h.call('POST', '/sessions', { sessionId: 'a', cwd: '/x', activeAt: 9 });
    expect(seen).toEqual([5, 9]);
    expect((await h.call('POST', '/sessions', { sessionId: 'a', cwd: '/x', activeAt: 'soon' })).status).toBe(400);
  });

  it('keeps startedAt and promptAt and reports a change in either', async () => {
    const h = await start();
    const seen: (number | undefined)[][] = [];
    h.server.onSessionsChange((s) => seen.push([s.sessions[0]?.startedAt, s.sessions[0]?.promptAt]));
    await h.call('POST', '/sessions', { sessionId: 'a', cwd: '/x', startedAt: 5 });
    await h.call('POST', '/sessions', { sessionId: 'a', cwd: '/x', startedAt: 5 });
    await h.call('POST', '/sessions', { sessionId: 'a', cwd: '/x', startedAt: 5, promptAt: 5 });
    expect(seen).toEqual([
      [5, undefined],
      [5, 5],
    ]);
    expect((await h.call('POST', '/sessions', { sessionId: 'a', cwd: '/x', promptAt: 'now' })).status).toBe(400);
  });

  it('fires onSessionsChange on real changes only, and unsubscribes', async () => {
    const h = await start();
    const seen: (string | undefined)[] = [];
    const off = h.server.onSessionsChange((s) => seen.push(s.targetSessionId));
    await h.call('POST', '/sessions', { sessionId: 'a', cwd: '/x' });
    await h.call('POST', '/sessions', { sessionId: 'a', cwd: '/x' });
    await h.call('POST', '/sessions', { sessionId: 'b', cwd: '/y' });
    h.server.setTarget('b');
    await h.call('DELETE', '/sessions/b');
    expect(seen).toEqual([undefined, undefined, 'b', undefined]);
    off();
    await h.call('DELETE', '/sessions/a');
    expect(seen).toHaveLength(4);
  });
});

describe('outputs path', () => {
  it('sets outputsPath on every session, tracked or not, in the list, the single answer and the change event', async () => {
    const h = await startTracked();
    const seen: unknown[] = [];
    h.server.onSessionsChange((s) => seen.push(s.sessions.map((x) => x.outputsPath)));
    await h.call('POST', '/sessions', { sessionId: 'a', cwd: '/x' });
    await h.call('POST', '/sessions', { sessionId: 'b c', cwd: '/y' });
    h.tracked.set('a', true);
    const list: SessionInfo[] = (await h.call('GET', '/sessions')).body.sessions;
    expect(list.map((s) => s.outputsPath)).toEqual(['/x/.feedback/outputs/a.json', '/y/.feedback/outputs/b c.json']);
    expect((await h.call('GET', '/sessions/b%20c')).body.outputsPath).toBe('/y/.feedback/outputs/b c.json');
    expect(h.server.sessions().sessions[0].outputsPath).toBe('/x/.feedback/outputs/a.json');
    expect(seen.at(-1)).toEqual(['/x/.feedback/outputs/a.json', '/y/.feedback/outputs/b c.json']);
  });

  it('ignores an outputsPath the session sends when it registers', async () => {
    const h = await start();
    await h.call('POST', '/sessions', { sessionId: 'a', cwd: '/x', outputsPath: '/etc/passwd' });
    expect((await h.call('GET', '/sessions/a')).body.outputsPath).toBe('/x/.feedback/outputs/a.json');
  });
});

describe('item tracking', () => {
  it('answers one session with its tracking, and 404 for an unknown one', async () => {
    const h = await startTracked();
    await h.call('POST', '/sessions', { sessionId: 'a', cwd: '/x', title: 'T' });
    const plain = await h.call('GET', '/sessions/a');
    expect(plain.status).toBe(200);
    expect(plain.body).toEqual({ sessionId: 'a', cwd: '/x', title: 'T', lastSeen: h.clock.t, outputsPath: '/x/.feedback/outputs/a.json' });

    h.tracked.set('a', true);
    expect((await h.call('GET', '/sessions/a')).body).toMatchObject({ trackItems: true, itemsPath: '/x/.feedback/items/a.md' });
    h.tracked.set('a', false);
    const off = (await h.call('GET', '/sessions/a')).body;
    expect(off.trackItems).toBe(false);
    expect(off.itemsPath).toBeUndefined();

    const missing = await h.call('GET', '/sessions/zzz');
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('not_found');
  });

  it('turns tracking on and off, fires onSessionsChange, and answers the session', async () => {
    const h = await startTracked();
    await h.call('POST', '/sessions', { sessionId: 'a b', cwd: '/x' });
    const seen: unknown[] = [];
    h.server.onSessionsChange((s) => seen.push(s.sessions[0]?.trackItems));

    const on = await h.call('PATCH', '/sessions/a%20b', { trackItems: true });
    expect(on.status).toBe(200);
    expect(on.body).toMatchObject({ sessionId: 'a b', trackItems: true, itemsPath: '/x/.feedback/items/a b.md' });
    expect(h.backend.setTracking).toHaveBeenCalledWith('a b', true);

    const off = await h.call('PATCH', '/sessions/a%20b', { trackItems: false });
    expect(off.body).toMatchObject({ sessionId: 'a b', trackItems: false });
    expect(off.body.itemsPath).toBeUndefined();
    expect(seen).toEqual([true, false]);
  });

  it('refuses a bad body and an unknown session', async () => {
    const h = await startTracked();
    await h.call('POST', '/sessions', { sessionId: 'a', cwd: '/x' });
    for (const body of [undefined, {}, { trackItems: 'yes' }, [true]]) {
      const r = await h.call('PATCH', '/sessions/a', body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.body.code).toBe('bad_request');
    }
    const missing = await h.call('PATCH', '/sessions/zzz', { trackItems: true });
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('not_found');
    expect(h.backend.setTracking).not.toHaveBeenCalled();
  });

  it('answers 503 when the backend keeps no tracking', async () => {
    const h = await start();
    await h.call('POST', '/sessions', { sessionId: 'a', cwd: '/x' });
    const r = await h.call('PATCH', '/sessions/a', { trackItems: true });
    expect(r.status).toBe(503);
    expect(r.body.code).toBe('unavailable');
  });

  it('carries tracking on every session in the list', async () => {
    const h = await startTracked();
    await h.call('POST', '/sessions', { sessionId: 'a', cwd: '/x' });
    await h.call('POST', '/sessions', { sessionId: 'b', cwd: '/y' });
    await h.call('POST', '/sessions', { sessionId: 'c', cwd: '/z' });
    await h.call('PATCH', '/sessions/a', { trackItems: true });
    await h.call('PATCH', '/sessions/b', { trackItems: false });
    const list: SessionInfo[] = (await h.call('GET', '/sessions')).body.sessions;
    expect(list.map((s) => [s.sessionId, s.trackItems, s.itemsPath])).toEqual([
      ['a', true, '/x/.feedback/items/a.md'],
      ['b', false, undefined],
      ['c', undefined, undefined],
    ]);
    expect(h.server.sessions().sessions[0]).toMatchObject({ trackItems: true });
  });

  it('refreshSessions re-sends the list with its tracking', async () => {
    const h = await start({ tracking: () => ({ trackItems: true }) });
    await h.call('POST', '/sessions', { sessionId: 'a', cwd: '/x' });
    const fn = vi.fn();
    h.server.onSessionsChange(fn);
    h.server.refreshSessions();
    expect(fn).toHaveBeenCalledWith(expect.objectContaining({ sessions: [expect.objectContaining({ trackItems: true })] }));
  });
});

describe('session mode', () => {
  it('stores the mode and answers it on one session and in the list', async () => {
    const h = await startModed();
    await h.call('POST', '/sessions', { sessionId: 'b', cwd: '/y' });
    const r = await h.call('PATCH', '/sessions/a', { mode: 'product' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ sessionId: 'a', mode: 'product' });
    expect(r.body.fidelity).toBeUndefined();
    expect(h.backend.setMode).toHaveBeenCalledWith('a', { mode: 'product' });
    expect((await h.call('GET', '/sessions/a')).body).toMatchObject({ mode: 'product' });
    const list: SessionInfo[] = (await h.call('GET', '/sessions')).body.sessions;
    expect(list.map((s) => [s.sessionId, s.mode])).toEqual([
      ['a', 'product'],
      ['b', undefined],
    ]);
  });

  it('keeps a fidelity with prototype, and drops it on a switch to another mode', async () => {
    const h = await startModed();
    const proto = await h.call('PATCH', '/sessions/a', { mode: 'prototype', fidelity: 'freeze-patch' });
    expect(proto.body).toMatchObject({ mode: 'prototype', fidelity: 'freeze-patch' });
    const product = await h.call('PATCH', '/sessions/a', { mode: 'product' });
    expect(product.body.mode).toBe('product');
    expect(product.body.fidelity).toBeUndefined();
    expect((await h.call('GET', '/sessions/a')).body.fidelity).toBeUndefined();
  });

  it('clears the mode on default', async () => {
    const h = await startModed();
    await h.call('PATCH', '/sessions/a', { mode: 'orchestrate' });
    const r = await h.call('PATCH', '/sessions/a', { mode: 'default' });
    expect(r.status).toBe(200);
    expect('mode' in r.body).toBe(false);
    expect('mode' in (await h.call('GET', '/sessions/a')).body).toBe(false);
  });

  it('refuses a bad mode or fidelity, and an unknown session', async () => {
    const h = await startModed();
    for (const body of [
      { mode: 'fast' },
      { mode: 3 },
      { fidelity: 'wireframe' },
      { mode: 'product', fidelity: 'wireframe' },
      { mode: 'prototype', fidelity: 'sketchy' },
      { trackItems: true, mode: 'fast' },
    ]) {
      const r = await h.call('PATCH', '/sessions/a', body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.body.code).toBe('bad_request');
    }
    const missing = await h.call('PATCH', '/sessions/zzz', { mode: 'product' });
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('not_found');
    expect(h.backend.setMode).not.toHaveBeenCalled();
    expect(h.backend.setTracking).not.toHaveBeenCalled();
  });

  it('applies tracking and mode from one body', async () => {
    const h = await startModed();
    const r = await h.call('PATCH', '/sessions/a', { trackItems: true, mode: 'prototype', fidelity: 'wireframe' });
    expect(r.body).toMatchObject({ trackItems: true, itemsPath: '/x/.feedback/items/a.md', mode: 'prototype', fidelity: 'wireframe' });
    expect(h.backend.setTracking).toHaveBeenCalledWith('a', true);
    expect(h.backend.setMode).toHaveBeenCalledWith('a', { mode: 'prototype', fidelity: 'wireframe' });
  });

  it('fires onSessionsChange with the mode', async () => {
    const h = await startModed();
    const seen: unknown[] = [];
    h.server.onSessionsChange((s) => seen.push([s.sessions[0]?.mode, s.sessions[0]?.fidelity]));
    await h.call('PATCH', '/sessions/a', { mode: 'prototype', fidelity: 'live-patch' });
    await h.call('PATCH', '/sessions/a', { mode: 'default' });
    expect(seen).toEqual([
      ['prototype', 'live-patch'],
      [undefined, undefined],
    ]);
  });

  it('answers 503 when the backend mirrors no modes, and sets nothing', async () => {
    const h = await startTracked();
    await h.call('POST', '/sessions', { sessionId: 'a', cwd: '/x' });
    const r = await h.call('PATCH', '/sessions/a', { trackItems: true, mode: 'product' });
    expect(r.status).toBe(503);
    expect(r.body.code).toBe('unavailable');
    expect(h.backend.setTracking).not.toHaveBeenCalled();
  });
});
