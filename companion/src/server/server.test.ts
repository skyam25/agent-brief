import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCompanionServer } from './index';
import { harness, request, tempDir } from './testkit';

const open: { close(): Promise<void> }[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

async function start() {
  const h = harness();
  open.push(h.server);
  await h.server.listen();
  return h;
}

describe('lifecycle', () => {
  it('answers /health', async () => {
    const h = await start();
    const r = await h.call('GET', '/health');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      ok: true,
      version: 1,
      pid: process.pid,
      panelVisible: true,
      currentBoard: 'main',
    });
  });

  it('sets the socket mode to 0600', async () => {
    const h = await start();
    expect(statSync(h.socketPath).mode & 0o777).toBe(0o600);
  });

  it('creates the parent directory', async () => {
    const dir = tempDir();
    const socketPath = join(dir, 'a', 'b', 's.sock');
    const server = createCompanionServer({ socketPath, backend: harness().backend });
    open.push(server);
    await server.listen();
    expect(existsSync(socketPath)).toBe(true);
  });

  it('replaces a stale socket file', async () => {
    const dir = tempDir();
    const socketPath = join(dir, 's.sock');
    const dead = net.createServer().listen(socketPath);
    await new Promise((r) => dead.once('listening', r));
    // Closing a net server unlinks the path, so recreate a stale file by hand.
    dead.close();
    await new Promise((r) => dead.once('close', r));
    writeFileSync(socketPath, '');
    const server = createCompanionServer({ socketPath, backend: harness().backend });
    open.push(server);
    await server.listen();
    expect((await request(socketPath, 'GET', '/health')).status).toBe(200);
  });

  it('refuses to start over a live server', async () => {
    const h = await start();
    const second = createCompanionServer({ socketPath: h.socketPath, backend: h.backend });
    await expect(second.listen()).rejects.toThrow(/already listening/);
    expect((await h.call('GET', '/health')).status).toBe(200);
  });
});

describe('errors', () => {
  it('returns 404 not_found for unknown routes', async () => {
    const h = await start();
    for (const [m, p] of [
      ['GET', '/nope'],
      ['POST', '/health'],
      ['GET', '/boards/x/other'],
    ]) {
      const r = await h.call(m, p);
      expect(r.status).toBe(404);
      expect(r.body.code).toBe('not_found');
      expect(typeof r.body.error).toBe('string');
    }
  });

  it('returns 400 for malformed JSON', async () => {
    const h = await start();
    const r = await request(h.socketPath, 'POST', '/sessions', undefined, '{oops');
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('bad_request');
  });

  it('returns 400 for bad fields', async () => {
    const h = await start();
    const bad: [string, string, unknown, RegExp][] = [
      ['POST', '/sessions', { sessionId: 's' }, /cwd/],
      ['POST', '/sessions', [], /object/],
      ['POST', '/boards/b/draw', { elements: [{ type: 'blob' }] }, /type/],
      ['POST', '/boards/b/draw', { elements: [{ type: 'text', x: null }] }, /finite/],
      ['POST', '/boards/b/draw', { elements: [{ type: 'text', id: 4 }] }, /id/],
      ['POST', '/boards/b/draw', { elements: [{ type: 'arrow', start: {} }] }, /start/],
      ['POST', '/boards/b/draw', { elements: [{ type: 'text', color: 'teal' }] }, /color/],
      ['POST', '/boards/b/draw', {}, /elements/],
      ['PATCH', '/boards/b/elements', { updates: [{ id: 3 }] }, /id/],
      ['PATCH', '/boards/b/elements', { updates: [{ id: 'a', width: 'wide' }] }, /width/],
      ['DELETE', '/boards/b/elements', { ids: [1] }, /ids/],
      ['GET', '/boards/b/elements?region=1,2,3', undefined, /region/],
      ['GET', '/boards/b/png?maxEdge=-4', undefined, /maxEdge/],
      ['GET', '/deliveries', undefined, /session/],
      ['GET', '/deliveries?session=s&wait=abc', undefined, /wait/],
    ];
    for (const [method, path, body, message] of bad) {
      const r = await h.call(method, path, body);
      expect(r.status, `${method} ${path}`).toBe(400);
      expect(r.body.code).toBe('bad_request');
      expect(r.body.error).toMatch(message);
    }
    expect(h.backend.draw).not.toHaveBeenCalled();
  });

  it('rejects bodies over 20 MB', async () => {
    const h = await start();
    const big = JSON.stringify({ elements: [], pad: 'x'.repeat(21 * 1024 * 1024) });
    const r = await request(h.socketPath, 'POST', '/boards/b/draw', undefined, big).catch(
      (e) => ({ status: 0, body: e }),
    );
    // The server may close the socket while the client is still writing.
    if (r.status !== 0) {
      expect(r.status).toBe(413);
      expect(r.body.code).toBe('bad_request');
    }
  });

  it('maps backend errors', async () => {
    const h = await start();
    h.backend.read.mockRejectedValueOnce(Object.assign(new Error('no board'), { code: 'not_found' }));
    const missing = await h.call('GET', '/boards/zz/elements');
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: 'no board', code: 'not_found' });

    h.backend.read.mockRejectedValueOnce(new Error('boom'));
    const boom = await h.call('GET', '/boards/zz/elements');
    expect(boom.status).toBe(500);
    expect(boom.body).toEqual({ error: 'boom', code: 'internal' });
  });
});

describe('board routes', () => {
  it('lists boards', async () => {
    const h = await start();
    const r = await h.call('GET', '/boards');
    expect(r.body).toEqual({ boards: [], current: 'main' });
  });

  it('reads elements with and without a region, decoding the name', async () => {
    const h = await start();
    await h.call('GET', '/boards/current/elements');
    expect(h.backend.read).toHaveBeenLastCalledWith('current', undefined);

    const r = await h.call('GET', '/boards/my%20board/elements?region=1,2.5,30,-4');
    expect(r.status).toBe(200);
    expect(r.body.board).toBe('my board');
    expect(h.backend.read).toHaveBeenLastCalledWith('my board', {
      x: 1,
      y: 2.5,
      width: 30,
      height: -4,
    });
  });

  it('serves png with region and maxEdge', async () => {
    const h = await start();
    const r = await h.call('GET', '/boards/current/png?region=0,0,100,50&maxEdge=800');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('image/png');
    expect([...r.raw]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(h.backend.png).toHaveBeenLastCalledWith('current', {
      region: { x: 0, y: 0, width: 100, height: 50 },
      maxEdge: 800,
    });

    await h.call('GET', '/boards/b/png');
    expect(h.backend.png).toHaveBeenLastCalledWith('b', { region: undefined, maxEdge: undefined });
  });

  it('draws', async () => {
    const h = await start();
    const req = {
      elements: [
        { id: 'r', type: 'rectangle', x: 1, y: 2, width: 3, height: 4, label: 'hi', color: 'red' },
        { type: 'arrow', start: { id: 'r' }, end: { x: 5, y: 6 } },
        { type: 'line', points: [[0, 0], [4, 4]] },
      ],
    };
    const r = await h.call('POST', '/boards/current/draw', req);
    expect(r.body).toEqual({ ids: ['a'], batchId: 'b1' });
    expect(h.backend.draw).toHaveBeenCalledWith('current', req);
  });

  it('updates and deletes', async () => {
    const h = await start();
    const updates = { updates: [{ id: 'a', x: 1, label: 'new', color: 'blue' }] };
    const u = await h.call('PATCH', '/boards/b%2F1/elements', updates);
    expect(u.body).toEqual({ ids: ['a'], batchId: 'b2' });
    expect(h.backend.update).toHaveBeenCalledWith('b/1', updates);

    const d = await h.call('DELETE', '/boards/b/elements', { ids: ['a', 'c'] });
    expect(d.body).toEqual({ ids: ['a'], batchId: 'b3' });
    expect(h.backend.remove).toHaveBeenCalledWith('b', { ids: ['a', 'c'] });
  });
});

describe('open', () => {
  it('delegates, sets the target and fires onOpen after the backend resolves', async () => {
    const h = await start();
    await h.call('POST', '/sessions', { sessionId: 'a', cwd: '/x' });
    await h.call('POST', '/sessions', { sessionId: 'b', cwd: '/y' });
    const order: string[] = [];
    h.backend.open.mockImplementationOnce(async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push('backend');
      return { board: 'idea' };
    });
    h.server.onOpen((req) => order.push(`open:${req.prompt}`));

    const r = await h.call('POST', '/open', { board: 'idea', sessionId: 'b', prompt: 'draw it' });
    expect(r.body).toEqual({ board: 'idea', targetSessionId: 'b' });
    expect(h.backend.open).toHaveBeenCalledWith({
      board: 'idea',
      sessionId: 'b',
      prompt: 'draw it',
    });
    expect(order).toEqual(['backend', 'open:draw it']);
    expect(h.server.sessions().targetSessionId).toBe('b');
  });

  it('passes the mode through and refuses an unknown one', async () => {
    const h = await start();
    await h.call('POST', '/open', { mode: 'write' });
    expect(h.backend.open).toHaveBeenCalledWith(expect.objectContaining({ mode: 'write' }));
    const bad = await h.call('POST', '/open', { mode: 'draw' });
    expect(bad.status).toBe(400);
    h.backend.open.mockImplementationOnce(async () => ({ board: 'scratch', noteText: true }));
    expect((await h.call('POST', '/open', { mode: 'write', text: 'from the box' })).body).toMatchObject({ noteText: true });
    expect(h.backend.open).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'write', text: 'from the box' }));
    expect((await h.call('POST', '/open', { mode: 'write', text: 'x'.repeat(200_001) })).status).toBe(400);
  });

  it('accepts an empty body', async () => {
    const h = await start();
    const r = await h.call('POST', '/open');
    expect(r.status).toBe(200);
  });
});

describe('sessions', () => {
  it('registers, lists and removes', async () => {
    const h = await start();
    const host = { terminal: 'ghostty', bundleId: 'com.mitchellh.ghostty', herdrPane: 'w1:p2' };
    const reg = await h.call('POST', '/sessions', { sessionId: 'a', cwd: '/x', title: 'T', pid: 7, summary: 'fix the header', host });
    expect(reg.status).toBe(200);
    const list = await h.call('GET', '/sessions');
    expect(list.body).toEqual({
      sessions: [{ sessionId: 'a', cwd: '/x', title: 'T', pid: 7, summary: 'fix the header', host, lastSeen: h.clock.t }],
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

describe('deliveries', () => {
  const png = Buffer.from([1, 2, 3]);

  /** Registers a session and, unless `pick` is false, makes it the target. */
  async function withSession(h: Awaited<ReturnType<typeof start>>, id = 'a', pick = true) {
    const cwd = tempDir('proj');
    await h.call('POST', '/sessions', { sessionId: id, cwd });
    if (pick) h.server.setTarget(id);
    return cwd;
  }

  it('answers at once when queued', async () => {
    const h = await start();
    await withSession(h);
    const d = await h.server.deliver({ png, scene: {}, boardName: 'main' });
    const t0 = Date.now();
    const r = await h.call('GET', '/deliveries?session=a&wait=10');
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(r.body.deliveries).toEqual([d]);
  });

  it('wakes a held poll when a delivery arrives', async () => {
    const h = await start();
    await withSession(h);
    const t0 = Date.now();
    const held = h.call('GET', '/deliveries?session=a&wait=20');
    await new Promise((r) => setTimeout(r, 100));
    const d = await h.server.deliver({ png, scene: {}, boardName: 'main' });
    const r = await held;
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(r.body.deliveries.map((x: { id: string }) => x.id)).toEqual([d.id]);
  });

  it('times out empty', async () => {
    const h = await start();
    await withSession(h);
    const t0 = Date.now();
    const r = await h.call('GET', '/deliveries?session=a&wait=1');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
    expect(r.body).toEqual({ deliveries: [] });
  });

  it('clamps wait to 0..30', async () => {
    const h = await start();
    await withSession(h);
    const t0 = Date.now();
    await h.call('GET', '/deliveries?session=a&wait=-5');
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it('releases held polls on close', async () => {
    const h = await start();
    await withSession(h);
    const held = h.call('GET', '/deliveries?session=a&wait=30');
    await new Promise((r) => setTimeout(r, 100));
    const t0 = Date.now();
    await h.server.close();
    const r = await held.catch(() => ({ body: { deliveries: [] } }));
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(r.body.deliveries).toEqual([]);
  });

  it('keeps deliveries until acked, then removes them', async () => {
    const h = await start();
    await withSession(h);
    const a = await h.server.deliver({ png, scene: {}, boardName: 'main' });
    const b = await h.server.deliver({ png, scene: {}, boardName: 'main' });
    expect(b.id).not.toBe(a.id);
    const first = await h.call('GET', '/deliveries?session=a&wait=0');
    const again = await h.call('GET', '/deliveries?session=a&wait=0');
    expect(first.body.deliveries).toHaveLength(2);
    expect(again.body.deliveries).toHaveLength(2);

    const ack = await h.call('POST', `/deliveries/${a.id}/ack`);
    expect(ack.body).toEqual({ acked: true });
    const left = await h.call('GET', '/deliveries?session=a&wait=0');
    expect(left.body.deliveries.map((x: { id: string }) => x.id)).toEqual([b.id]);
    expect((await h.call('POST', `/deliveries/${a.id}/ack`)).body).toEqual({ acked: false });
  });

  it('queues per session', async () => {
    const h = await start();
    await withSession(h, 'a');
    await withSession(h, 'b');
    await h.server.deliver({ sessionId: 'b', png, scene: {}, boardName: 'main' });
    expect((await h.call('GET', '/deliveries?session=a&wait=0')).body.deliveries).toEqual([]);
    expect((await h.call('GET', '/deliveries?session=b&wait=0')).body.deliveries).toHaveLength(1);
  });

  it('rejects with no session', async () => {
    const h = await start();
    await expect(h.server.deliver({ png, scene: {}, boardName: 'main' })).rejects.toThrow(
      /no Claude Code session/,
    );
    await expect(
      h.server.deliver({ sessionId: 'ghost', png, scene: {}, boardName: 'main' }),
    ).rejects.toThrow(/unknown session/);
  });

  it('writes every file and builds the draft', async () => {
    const h = await start();
    const cwd = await withSession(h);
    const scene = { type: 'excalidraw', elements: [{ id: 'e' }] };
    const transcript = [{ t: 0, tEnd: 1, text: 'hi' }];
    const d = await h.server.deliver({
      png,
      scene,
      boardName: 'idea board',
      notes: 'line one\nline two  ' + 'z'.repeat(400),
      timelineMd: '[00:01] stroke 1',
      transcript,
      audio: [
        { name: 'a.webm', data: Buffer.from('AUDIO') },
        { name: '../evil.webm', data: Buffer.from('X') },
      ],
      speech: 'this is the header',
      mode: 'submit',
    });

    expect(d.id).toMatch(/^\d{4}-\d{2}-\d{2}-\d{6}$/);
    expect(d.dir).toBe(join(cwd, '.feedback', 'sketches', d.id));
    expect(d.mode).toBe('submit');
    expect(d.sessionId).toBe('a');
    expect(d.createdAt).toBe(h.clock.t);

    const read = (f: string) => readFileSync(join(d.dir, f));
    expect([...read('sketch.png')]).toEqual([1, 2, 3]);
    expect(read('board.excalidraw').toString()).toBe(JSON.stringify(scene, null, 2));
    expect(read('notes.md').toString()).toContain('line two');
    expect(read('timeline.md').toString()).toBe('[00:01] stroke 1');
    expect(JSON.parse(read('transcript.json').toString())).toEqual(transcript);
    expect(read('audio/a.webm').toString()).toBe('AUDIO');
    expect(read('audio/evil.webm').toString()).toBe('X');
    expect(existsSync(join(cwd, '.gitignore'))).toBe(false);

    const notes = 'line one line two ' + 'z'.repeat(400);
    expect(d.draft).toBe(
      [
        `@.feedback/sketches/${d.id}/sketch.png`,
        'Sketch from the Agent Brief board "idea board".',
        'Said while drawing: "this is the header"',
        `Notes: ${notes.slice(0, 300)}`,
        `Timeline: .feedback/sketches/${d.id}/timeline.md`,
      ].join('\n'),
    );
  });

  it('writes only what it was given and defaults to fill', async () => {
    const h = await start();
    const cwd = await withSession(h);
    const d = await h.server.deliver({ png, scene: {}, boardName: 'main' });
    expect(d.mode).toBe('fill');
    expect(d.draft).toBe(
      `@.feedback/sketches/${d.id}/sketch.png\nSketch from the Agent Brief board "main".`,
    );
    for (const f of ['notes.md', 'timeline.md', 'transcript.json', 'audio']) {
      expect(existsSync(join(cwd, '.feedback/sketches', d.id, f))).toBe(false);
    }
  });

  it('adds a suffix when the id collides', async () => {
    const h = await start();
    await withSession(h);
    const a = await h.server.deliver({ png, scene: {}, boardName: 'main' });
    const b = await h.server.deliver({ png, scene: {}, boardName: 'main' });
    expect(b.id.startsWith(a.id)).toBe(true);
    expect(b.id).toMatch(/-[0-9a-f]{4}$/);
  });

  it('delivers to the target by default', async () => {
    const h = await start();
    await withSession(h, 'a', false);
    const cwdB = await withSession(h, 'b', false);
    h.server.setTarget('b');
    const d = await h.server.deliver({ png, scene: {}, boardName: 'main' });
    expect(d.sessionId).toBe('b');
    expect(d.dir.startsWith(cwdB)).toBe(true);
  });
});
