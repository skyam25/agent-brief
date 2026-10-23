import { existsSync, statSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCompanionServer } from './index';
import { closeServers, openServers, start } from './server-testkit';
import { harness, request, tempDir } from './testkit';
import { BadRequest } from './validate';

afterEach(closeServers);

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
    openServers.push(server);
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
    openServers.push(server);
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
      ['POST', '/boards/b/draw', { elements: [{ type: 'image', image: 'data:text/html;base64,AAAA', width: 1, height: 1 }] }, /data URL/],
      ['POST', '/boards/b/draw', { elements: [{ type: 'image', image: 'data:image/png;base64,AAAA' }] }, /width and height/],
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
    expect(r.body).toEqual({ board: 'idea', opened: 'board', targetSessionId: 'b' });
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

  it('passes the layout through and refuses an unknown one', async () => {
    const h = await start();
    await h.call('POST', '/open', { board: 'shots', layout: 'stack' });
    expect(h.backend.open).toHaveBeenCalledWith(expect.objectContaining({ board: 'shots', layout: 'stack' }));
    expect((await h.call('POST', '/open', { layout: 'grid' })).status).toBe(400);
  });

  it('accepts an empty body', async () => {
    const h = await start();
    const r = await h.call('POST', '/open');
    expect(r.status).toBe(200);
  });

  it('says a Write open shows a note', async () => {
    const h = await start();
    expect((await h.call('POST', '/open', { mode: 'write' })).body).toMatchObject({ opened: 'note' });
  });

  it('opens an output of a live session and sets it as the target', async () => {
    const h = await start();
    await h.call('POST', '/sessions', { sessionId: 'a', cwd: '/x' });
    await h.call('POST', '/sessions', { sessionId: 'b', cwd: '/y' });
    h.backend.open.mockImplementationOnce(async () => ({ board: 'main', opened: 'review' as const }));
    const r = await h.call('POST', '/open', { sessionId: 'a', output: { path: ' docs/page.html ' } });
    expect(r.body).toEqual({ board: 'main', opened: 'review', targetSessionId: 'a' });
    expect(h.backend.open).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'a', output: { path: 'docs/page.html' } }));
    expect(h.server.sessions().targetSessionId).toBe('a');
  });

  it('passes the Feedback tab an open asks for', async () => {
    const h = await start();
    await h.call('POST', '/sessions', { sessionId: 'a', cwd: '/x' });
    await h.call('POST', '/open', { sessionId: 'a', output: { path: 'page.html', tab: 'feedback' } });
    expect(h.backend.open).toHaveBeenCalledWith(expect.objectContaining({ output: { path: 'page.html', tab: 'feedback' } }));
    for (const path of ['deck.pdf', 'brief.docx', 'slides.pptx', 'model.xlsx', 'diagram.svg']) {
      expect((await h.call('POST', '/open', { sessionId: 'a', output: { path, tab: 'feedback' } })).status).toBe(200);
      expect(h.backend.open).toHaveBeenLastCalledWith(expect.objectContaining({ output: { path, tab: 'feedback' } }));
    }
  });

  it('refuses an output without a live session or of the wrong type', async () => {
    const h = await start();
    await h.call('POST', '/sessions', { sessionId: 'a', cwd: '/x' });
    const bad = [
      { output: { path: 'plan.md' } },
      { sessionId: 'gone', output: { path: 'plan.md' } },
      { sessionId: 'a', output: { path: 'deck.pdf' } },
      { sessionId: 'a', output: { path: '' } },
      { sessionId: 'a', output: 'plan.md' },
      { sessionId: 'a', output: { path: 'plan.md', tab: 'comments' } },
    ];
    for (const body of bad) {
      const r = await h.call('POST', '/open', body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.body.code).toBe('bad_request');
    }
    expect(h.backend.open).not.toHaveBeenCalled();
  });

  it("answers 400 with the backend's reason when the file is not in the session's folder", async () => {
    const h = await start();
    await h.call('POST', '/sessions', { sessionId: 'a', cwd: '/x' });
    h.backend.open.mockImplementationOnce(async () => {
      throw new BadRequest('../escape.md is outside the project');
    });
    const r = await h.call('POST', '/open', { sessionId: 'a', output: { path: '../escape.md' } });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: '../escape.md is outside the project', code: 'bad_request' });
  });
});
