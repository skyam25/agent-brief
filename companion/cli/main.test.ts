import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ReadResponse } from '../src/protocol';
import { main } from './main';
import { fail, useFakeApp } from './testkit';

const { app, run } = useFakeApp();

describe('status, sessions, boards, open', () => {
  it('prints health', async () => {
    app.handler = () => ({ json: { ok: true, version: 1, pid: 42, panelVisible: true, currentBoard: 'main' } });
    const r = await run(['status']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('running');
    expect(r.stdout).toContain('pid 42');
    expect(app.seen[0]).toMatchObject({ method: 'GET', url: '/health' });
  });

  it('prints raw JSON with --json', async () => {
    const health = { ok: true, version: 1, pid: 1, panelVisible: false, currentBoard: 'x' };
    app.handler = () => ({ json: health });
    const r = await run(['status', '--json']);
    expect(JSON.parse(r.stdout)).toEqual(health);
  });

  it('marks the target session', async () => {
    app.handler = () => ({
      json: {
        sessions: [
          { sessionId: 's1', cwd: '/a' },
          { sessionId: 's2', cwd: '/b', title: 'work' },
        ],
        targetSessionId: 's2',
      },
    });
    const r = await run(['sessions']);
    expect(r.stdout).toContain('  s1  /a');
    expect(r.stdout).toContain('* s2  /b  "work"');
  });

  it('handles an empty session list', async () => {
    app.handler = () => ({ json: { sessions: [] } });
    expect((await run(['sessions'])).stdout).toContain('no sessions');
  });

  it('lists boards and marks the current one', async () => {
    app.handler = () => ({
      json: { boards: [{ name: 'a', updatedAt: 0, elementCount: 1 }, { name: 'b', updatedAt: 0, elementCount: 3 }], current: 'b' },
    });
    const r = await run(['boards']);
    expect(r.stdout).toContain('  a  1 element  ');
    expect(r.stdout).toContain('* b  3 elements');
  });

  it('opens with board, prompt and session', async () => {
    app.handler = () => ({ json: { board: 'flow', targetSessionId: 's9' } });
    const r = await run(['open', '--board', 'flow', '--prompt', 'Sketch it', '--session=s9']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('"flow"');
    expect(app.seen[0]).toEqual({
      method: 'POST',
      url: '/open',
      body: { board: 'flow', prompt: 'Sketch it', sessionId: 's9' },
    });
  });

  it('opens a board in the Stack layout', async () => {
    app.handler = () => ({ json: { board: 'shots' } });
    const r = await run(['open', '--board', 'shots', '--layout', 'stack']);
    expect(r.code).toBe(0);
    expect(app.seen[0].body).toEqual({ board: 'shots', layout: 'stack' });
  });

  it('rejects an unknown layout before calling the app', async () => {
    const r = await run(['open', '--layout', 'grid']);
    expect(r.code).toBe(2);
    expect(app.seen).toHaveLength(0);
  });

  it('opens with an empty body by default', async () => {
    app.handler = () => ({ json: { board: 'main' } });
    await run(['open']);
    expect(app.seen[0].body).toEqual({});
  });
});

describe('read', () => {
  const response: ReadResponse = {
    board: 'current',
    bounds: { x: 0, y: 0, width: 1200, height: 800 },
    elements: [
      { id: 'r1', type: 'rectangle', x: 40, y: 40, width: 400, height: 80, label: 'Header', color: 'blue', by: 'claude' },
      { id: 'fr', type: 'frame', x: 0, y: 200, width: 500, height: 300, label: 'Backend', by: 'claude' },
      { id: 'r2', type: 'rectangle', x: 20.4, y: 220, width: 200, height: 80, label: 'API', by: 'claude', frameId: 'fr' },
      { id: 'a1', type: 'arrow', x: 0, y: 0, width: 10, height: 10, by: 'claude', startId: 'r1', endId: 'r2' },
      { id: 'f3', type: 'freedraw', x: 300, y: 420, width: 120, height: 60, by: 'user' },
      { id: 'o1', type: 'sticky', x: 5, y: 6, width: 7, height: 8, by: 'user', frameId: 'gone' },
    ],
  };

  it('formats compact text with frame children grouped and arrows bound', async () => {
    app.handler = () => ({ json: response });
    const r = await run(['read']);
    expect(r.stdout.trimEnd().split('\n')).toEqual([
      'board "current" · 6 elements · bounds 0,0 1200×800',
      'r1 rectangle "Header" at 40,40 400×80 blue (claude)',
      'fr frame "Backend" at 0,200 500×300 (claude)',
      '  r2 rectangle "API" at 20,220 200×80 (claude)',
      'a1 arrow r1 → r2 (claude)',
      'f3 freedraw at 300,420 120×60 (user)',
      'o1 sticky at 5,6 7×8 (user)',
    ]);
    expect(app.seen[0].url).toBe('/boards/current/elements');
  });

  it('passes board and region in the request', async () => {
    app.handler = () => ({ json: response });
    await run(['read', '--board', 'my board', '--region', '0,10,300,200']);
    expect(app.seen[0].url).toBe('/boards/my%20board/elements?region=0,10,300,200');
  });

  it('prints raw JSON with --json', async () => {
    app.handler = () => ({ json: response });
    const r = await run(['read', '--json']);
    expect(JSON.parse(r.stdout)).toEqual(response);
  });

  it('takes a region in the shape read prints', async () => {
    app.handler = () => ({ json: { board: 'b', elements: [], bounds: { x: 0, y: 0, width: 0, height: 0 } } });
    await run(['read', '--region', '840,0 760×720']);
    await run(['read', '--region', '840,0 760,600']);
    expect(app.seen.map((s) => s.url)).toEqual(['/boards/current/elements?region=840,0,760,720', '/boards/current/elements?region=840,0,760,600']);
  });

  it('rejects a bad region before sending', async () => {
    const r = await run(['read', '--region', '1,2,3']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--region');
    expect(app.seen).toHaveLength(0);
  });

  it('formats an empty board', async () => {
    app.handler = () => ({ json: { board: 'e', elements: [], bounds: { x: 0, y: 0, width: 0, height: 0 } } });
    expect((await run(['read'])).stdout).toBe('board "e" · 0 elements · bounds 0,0 0×0\n');
  });
});

describe('png', () => {
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

  it('writes bytes to --out and prints the path', async () => {
    app.handler = () => ({ raw: bytes });
    const out = path.join(app.dir, 'sub', 'a.png');
    const r = await run(['png', '--out', out]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe(out);
    expect(fs.readFileSync(out).equals(bytes)).toBe(true);
    expect(app.seen[0].url).toBe('/boards/current/png');
  });

  it('sends region and maxEdge', async () => {
    app.handler = () => ({ raw: bytes });
    await run(['png', '--board', 'b', '--region', '1,2,3,4', '--max-edge', '800', '--out', path.join(app.dir, 'x.png')]);
    expect(app.seen[0].url).toBe('/boards/b/png?region=1,2,3,4&maxEdge=800');
  });

  it('defaults the path under .feedback/boards', async () => {
    app.handler = () => ({ raw: bytes });
    const r = await run(['png', '--board', 'b']);
    const expected = path.join(app.dir, '.feedback/boards/b-20261010-153000.png');
    expect(r.stdout.trim()).toBe(expected);
    expect(fs.existsSync(expected)).toBe(true);
  });

  it('rejects a bad --max-edge', async () => {
    const r = await run(['png', '--max-edge', 'big']);
    expect(r.code).toBe(2);
    expect(app.seen).toHaveLength(0);
  });

  it('prints server errors and writes nothing', async () => {
    app.handler = fail('unavailable', 'panel is hidden', 503);
    const r = await run(['png', '--out', path.join(app.dir, 'n.png')]);
    expect(r.code).toBe(1);
    expect(r.stderr).toBe('error (unavailable): panel is hidden\n');
    expect(fs.existsSync(path.join(app.dir, 'n.png'))).toBe(false);
  });
});

describe('update and delete', () => {
  it('sends updates as a bare array or wrapped', async () => {
    app.handler = () => ({ json: { ids: ['a'], batchId: 'u1' } });
    const updates = [{ id: 'a', x: 5, label: 'New', color: 'red' }];
    const r1 = await run(['update'], JSON.stringify(updates));
    const r2 = await run(['update', '--board', 'b'], JSON.stringify({ updates }));
    expect(r1.stdout).toContain('updated 1 element, batch u1');
    expect(app.seen[0]).toEqual({ method: 'PATCH', url: '/boards/current/elements', body: { updates } });
    expect(app.seen[1].url).toBe('/boards/b/elements');
    expect(r2.code).toBe(0);
  });

  it('names the index of a bad update', async () => {
    const r = await run(['update'], JSON.stringify([{ id: 'a' }, { x: 3 }]));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('updates[1]: "id"');
    expect(app.seen).toHaveLength(0);
  });

  it('deletes ids and reports unknown ones', async () => {
    app.handler = () => ({ json: { ids: ['a'], batchId: 'd1' } });
    const r = await run(['delete', '--board', 'b', 'a', 'zz']);
    expect(app.seen[0]).toEqual({ method: 'DELETE', url: '/boards/b/elements', body: { ids: ['a', 'zz'] } });
    expect(r.stdout).toContain('deleted 1 element, batch d1');
    expect(r.stdout).toContain('not found: zz');
  });

  it('requires an id to delete', async () => {
    const r = await run(['delete']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('at least one id');
  });
});

describe('errors and help', () => {
  it('exits 3 with the message when the app is not running', async () => {
    await new Promise((ok) => app.server.close(ok));
    for (const argv of [['status'], ['read'], ['png'], ['boards']]) {
      const r = await run(argv);
      expect(r.code).toBe(3);
      expect(r.stderr).toBe('Agent Brief is not running. Start it, or run /sketch in Claude Code.\n');
    }
    app.server = http.createServer();
    await new Promise<void>((ok) => app.server.listen(app.socket, ok));
  });

  it('exits 3 for a socket file with no listener', async () => {
    await new Promise((ok) => app.server.close(ok));
    const missing = path.join(app.dir, 'missing.sock');
    let stderr = '';
    const code = await main(['status'], { stdin: async () => '', stdout() {}, stderr: (s) => (stderr += s), env: { COMPANION_SOCKET: missing } });
    expect(code).toBe(3);
    expect(stderr).toContain('not running');
    app.server = http.createServer();
    await new Promise<void>((ok) => app.server.listen(app.socket, ok));
  });

  it('prints a generic message for a non-JSON error body', async () => {
    app.handler = () => ({ status: 500, raw: Buffer.from('boom'), type: 'text/plain' });
    const r = await run(['boards']);
    expect(r.code).toBe(1);
    expect(r.stderr).toBe('error (internal): HTTP 500\n');
  });

  it('prints top-level help with a draw example', async () => {
    for (const argv of [['help'], ['--help'], []]) {
      const r = await run(argv);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('"type":"arrow","start":{"id":"a"},"end":{"id":"b"}');
    }
  });

  it('prints per-command help for every command', async () => {
    for (const cmd of ['status', 'sessions', 'boards', 'open', 'read', 'png', 'draw', 'update', 'delete']) {
      const r = await run([cmd, '--help']);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain(`agent-brief ${cmd}`);
      expect(r.stdout).toContain('Example:');
    }
    expect(app.seen).toHaveLength(0);
  });

  it('rejects unknown commands and options', async () => {
    expect((await run(['wat'])).code).toBe(2);
    const r = await run(['read', '--bogus']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--bogus');
  });
});
