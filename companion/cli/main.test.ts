import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ErrorBody, ReadResponse } from '../src/protocol';
import { main, nextSnapSlot } from './main';

/** A PNG header, which is all the CLI reads to size an image. */
function pngHeader(width: number, height: number): Buffer {
  const b = Buffer.alloc(33);
  b.writeUInt32BE(0x89504e47, 0);
  b.writeUInt32BE(0x0d0a1a0a, 4);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

interface Seen {
  method: string;
  url: string;
  body: unknown;
}

type Handler = (req: Seen) => { status?: number; json?: unknown; raw?: Buffer; type?: string };

let dir: string;
let socket: string;
let server: http.Server;
let seen: Seen[];
let handler: Handler;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmp-'));
  socket = path.join(dir, 's.sock');
  seen = [];
  handler = () => ({ json: {} });
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString();
      const entry: Seen = { method: req.method!, url: req.url!, body: text ? JSON.parse(text) : undefined };
      seen.push(entry);
      const r = handler(entry);
      res.statusCode = r.status ?? 200;
      if (r.raw) {
        res.setHeader('content-type', r.type ?? 'image/png');
        res.end(r.raw);
      } else {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(r.json));
      }
    });
  });
  await new Promise<void>((ok) => server.listen(socket, ok));
});

afterEach(async () => {
  await new Promise((ok) => server.close(ok));
  fs.rmSync(dir, { recursive: true, force: true });
});

async function run(argv: string[], stdin = '') {
  let stdout = '';
  let stderr = '';
  const code = await main(argv, {
    stdin: async () => stdin,
    stdout: (s) => (stdout += s),
    stderr: (s) => (stderr += s),
    env: { COMPANION_SOCKET: socket },
    cwd: dir,
    now: () => new Date('2026-10-10T15:30:00Z'),
  });
  return { code, stdout, stderr };
}

const fail = (code: ErrorBody['code'], error: string, status = 400): Handler => () => ({
  status,
  json: { code, error } satisfies ErrorBody,
});

describe('status, sessions, boards, open', () => {
  it('prints health', async () => {
    handler = () => ({ json: { ok: true, version: 1, pid: 42, panelVisible: true, currentBoard: 'main' } });
    const r = await run(['status']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('running');
    expect(r.stdout).toContain('pid 42');
    expect(seen[0]).toMatchObject({ method: 'GET', url: '/health' });
  });

  it('prints raw JSON with --json', async () => {
    const health = { ok: true, version: 1, pid: 1, panelVisible: false, currentBoard: 'x' };
    handler = () => ({ json: health });
    const r = await run(['status', '--json']);
    expect(JSON.parse(r.stdout)).toEqual(health);
  });

  it('marks the target session', async () => {
    handler = () => ({
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
    handler = () => ({ json: { sessions: [] } });
    expect((await run(['sessions'])).stdout).toContain('no sessions');
  });

  it('lists boards and marks the current one', async () => {
    handler = () => ({
      json: { boards: [{ name: 'a', updatedAt: 0, elementCount: 1 }, { name: 'b', updatedAt: 0, elementCount: 3 }], current: 'b' },
    });
    const r = await run(['boards']);
    expect(r.stdout).toContain('  a  1 element  ');
    expect(r.stdout).toContain('* b  3 elements');
  });

  it('opens with board, prompt and session', async () => {
    handler = () => ({ json: { board: 'flow', targetSessionId: 's9' } });
    const r = await run(['open', '--board', 'flow', '--prompt', 'Sketch it', '--session=s9']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('"flow"');
    expect(seen[0]).toEqual({
      method: 'POST',
      url: '/open',
      body: { board: 'flow', prompt: 'Sketch it', sessionId: 's9' },
    });
  });

  it('opens a board in the Stack layout', async () => {
    handler = () => ({ json: { board: 'shots' } });
    const r = await run(['open', '--board', 'shots', '--layout', 'stack']);
    expect(r.code).toBe(0);
    expect(seen[0].body).toEqual({ board: 'shots', layout: 'stack' });
  });

  it('rejects an unknown layout before calling the app', async () => {
    const r = await run(['open', '--layout', 'grid']);
    expect(r.code).toBe(2);
    expect(seen).toHaveLength(0);
  });

  it('opens with an empty body by default', async () => {
    handler = () => ({ json: { board: 'main' } });
    await run(['open']);
    expect(seen[0].body).toEqual({});
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
    handler = () => ({ json: response });
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
    expect(seen[0].url).toBe('/boards/current/elements');
  });

  it('passes board and region in the request', async () => {
    handler = () => ({ json: response });
    await run(['read', '--board', 'my board', '--region', '0,10,300,200']);
    expect(seen[0].url).toBe('/boards/my%20board/elements?region=0,10,300,200');
  });

  it('prints raw JSON with --json', async () => {
    handler = () => ({ json: response });
    const r = await run(['read', '--json']);
    expect(JSON.parse(r.stdout)).toEqual(response);
  });

  it('takes a region in the shape read prints', async () => {
    handler = () => ({ json: { board: 'b', elements: [], bounds: { x: 0, y: 0, width: 0, height: 0 } } });
    await run(['read', '--region', '840,0 760×720']);
    await run(['read', '--region', '840,0 760,600']);
    expect(seen.map((s) => s.url)).toEqual(['/boards/current/elements?region=840,0,760,720', '/boards/current/elements?region=840,0,760,600']);
  });

  it('rejects a bad region before sending', async () => {
    const r = await run(['read', '--region', '1,2,3']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--region');
    expect(seen).toHaveLength(0);
  });

  it('formats an empty board', async () => {
    handler = () => ({ json: { board: 'e', elements: [], bounds: { x: 0, y: 0, width: 0, height: 0 } } });
    expect((await run(['read'])).stdout).toBe('board "e" · 0 elements · bounds 0,0 0×0\n');
  });
});

describe('png', () => {
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

  it('writes bytes to --out and prints the path', async () => {
    handler = () => ({ raw: bytes });
    const out = path.join(dir, 'sub', 'a.png');
    const r = await run(['png', '--out', out]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe(out);
    expect(fs.readFileSync(out).equals(bytes)).toBe(true);
    expect(seen[0].url).toBe('/boards/current/png');
  });

  it('sends region and maxEdge', async () => {
    handler = () => ({ raw: bytes });
    await run(['png', '--board', 'b', '--region', '1,2,3,4', '--max-edge', '800', '--out', path.join(dir, 'x.png')]);
    expect(seen[0].url).toBe('/boards/b/png?region=1,2,3,4&maxEdge=800');
  });

  it('defaults the path under .feedback/boards', async () => {
    handler = () => ({ raw: bytes });
    const r = await run(['png', '--board', 'b']);
    const expected = path.join(dir, '.feedback/boards/b-20261010-153000.png');
    expect(r.stdout.trim()).toBe(expected);
    expect(fs.existsSync(expected)).toBe(true);
  });

  it('rejects a bad --max-edge', async () => {
    const r = await run(['png', '--max-edge', 'big']);
    expect(r.code).toBe(2);
    expect(seen).toHaveLength(0);
  });

  it('prints server errors and writes nothing', async () => {
    handler = fail('unavailable', 'panel is hidden', 503);
    const r = await run(['png', '--out', path.join(dir, 'n.png')]);
    expect(r.code).toBe(1);
    expect(r.stderr).toBe('error (unavailable): panel is hidden\n');
    expect(fs.existsSync(path.join(dir, 'n.png'))).toBe(false);
  });
});

describe('draw', () => {
  const elements = [
    { id: 'a', type: 'rectangle', x: 0, y: 0, width: 200, height: 80, label: 'A', color: 'blue' },
    { id: 'b', type: 'rectangle', x: 260, y: 0, label: 'B' },
    { type: 'arrow', start: { id: 'a' }, end: { id: 'b' } },
  ];

  beforeEach(() => {
    handler = () => ({ json: { ids: ['a', 'b', 'ar'], batchId: 'batch1' } });
  });

  it('accepts {"elements": [...]} on stdin', async () => {
    const r = await run(['draw'], JSON.stringify({ elements }));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('batch1');
    expect(r.stdout).toContain('ids: a b ar');
    expect(seen[0]).toEqual({ method: 'POST', url: '/boards/current/draw', body: { elements } });
  });

  it('accepts a bare array', async () => {
    await run(['draw', '--board', 'x'], JSON.stringify(elements));
    expect(seen[0].url).toBe('/boards/x/draw');
    expect(seen[0].body).toEqual({ elements });
  });

  it('reads --file relative to cwd', async () => {
    fs.writeFileSync(path.join(dir, 'd.json'), JSON.stringify(elements));
    const r = await run(['draw', '--file', 'd.json']);
    expect(r.code).toBe(0);
    expect(seen[0].body).toEqual({ elements });
  });

  it('names the index of a bad type', async () => {
    const r = await run(['draw'], JSON.stringify([elements[0], { type: 'blob' }]));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('elements[1]');
    expect(r.stderr).toContain('"type"');
    expect(seen).toHaveLength(0);
  });

  it('names the index of a bad number, color and endpoint', async () => {
    const bad = async (el: object) => (await run(['draw'], JSON.stringify({ elements: [elements[0], el] }))).stderr;
    expect(await bad({ type: 'text', x: 'left' })).toContain('elements[1]: "x" must be a number');
    expect(await bad({ type: 'text', color: 'teal' })).toContain('elements[1]: unknown color "teal"');
    expect(await bad({ type: 'arrow', start: { id: 'a' }, end: 5 })).toContain('elements[1]: "end"');
    expect(await bad({ type: 'arrow' })).toContain('elements[1]: arrow needs');
    expect(seen).toHaveLength(0);
  });

  it('rejects invalid JSON, empty input and wrong shape', async () => {
    expect((await run(['draw'], '{nope')).stderr).toContain('invalid JSON');
    expect((await run(['draw'], '  ')).stderr).toContain('no JSON on stdin');
    expect((await run(['draw'], '{"foo":1}')).stderr).toContain('{"elements"');
    expect((await run(['draw'], '[]')).stderr).toContain('no elements');
    expect(seen).toHaveLength(0);
  });

  it('prints server errors with exit 1', async () => {
    handler = fail('not_found', 'unknown frame f9', 404);
    const r = await run(['draw'], JSON.stringify(elements));
    expect(r.code).toBe(1);
    expect(r.stderr).toBe('error (not_found): unknown frame f9\n');
  });
});

describe('images', () => {
  beforeEach(() => {
    fs.writeFileSync(path.join(dir, 'shot.png'), pngHeader(1440, 900));
    handler = () => ({ json: { ids: ['i'], batchId: 'b1' } });
  });

  it('sends an image file as a data URL, sized from a width', async () => {
    const r = await run(['draw'], JSON.stringify([{ type: 'image', file: 'shot.png', x: 0, y: 0, width: 400 }]));
    expect(r.code).toBe(0);
    const [el] = (seen[0].body as { elements: Record<string, unknown>[] }).elements;
    expect(el.file).toBeUndefined();
    expect(el.image).toBe(`data:image/png;base64,${pngHeader(1440, 900).toString('base64')}`);
    expect([el.width, el.height]).toEqual([400, 250]);
  });

  it('defaults an image to 720 wide', async () => {
    await run(['draw'], JSON.stringify([{ type: 'image', file: 'shot.png' }]));
    const [el] = (seen[0].body as { elements: Record<string, unknown>[] }).elements;
    expect([el.width, el.height]).toEqual([720, 450]);
  });

  it('rejects an image without a file and a file that is not an image', async () => {
    expect((await run(['draw'], '[{"type":"image"}]')).stderr).toContain('elements[0]: image needs "file"');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'hello');
    expect((await run(['draw'], '[{"type":"image","file":"notes.txt"}]')).stderr).toContain('not a png, jpeg, gif or webp');
    expect((await run(['draw'], '[{"type":"image","file":"gone.png"}]')).stderr).toContain('cannot read image gone.png');
    expect(seen).toHaveLength(0);
  });

  it('prints warnings from the app', async () => {
    handler = () => ({ json: { ids: ['a'], batchId: 'b1', warnings: ['arrow a is 100 px long'] } });
    const r = await run(['draw'], '[{"type":"text","label":"x"}]');
    expect(r.stdout).toContain('warning: arrow a is 100 px long');
  });
});

describe('snap', () => {
  const empty: ReadResponse = { board: 'run', elements: [], bounds: { x: 0, y: 0, width: 0, height: 0 } };

  beforeEach(() => {
    fs.writeFileSync(path.join(dir, 'shot.png'), pngHeader(1440, 900));
  });

  it('draws a captioned frame with the picture and a note', async () => {
    handler = (req) => (req.method === 'GET' ? { json: empty } : { json: { ids: ['f1', 'i1', 'n1'], batchId: 'b1' } });
    const r = await run(['snap', 'shot.png', '--board', 'run', '--caption', 'Cart', '--note', 'Total is wrong']);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('snapshot 1 at 0,0 · frame f1 · image i1 · note n1\n');
    expect(seen[0]).toMatchObject({ method: 'GET', url: '/boards/run/elements' });
    const [frame, image, note] = (seen[1].body as { elements: Record<string, unknown>[] }).elements;
    expect(frame).toMatchObject({ type: 'frame', x: 0, y: 0, width: 760, height: 610, label: '1. Cart' });
    expect(image).toMatchObject({ type: 'image', x: 20, y: 20, width: 720, height: 450, frameId: 'snap' });
    expect(note).toMatchObject({ type: 'sticky', y: 490, label: 'Total is wrong', frameId: 'snap' });
  });

  it('needs a file and a positive width', async () => {
    expect((await run(['snap'])).stderr).toContain('snap needs an image file');
    expect((await run(['snap', 'shot.png', '--width', '0'])).stderr).toContain('--width must be a positive integer');
  });
});

describe('nextSnapSlot', () => {
  const frame = (id: string, x: number, y: number, height = 500) =>
    [
      { id, type: 'frame' as const, x, y, width: 760, height, by: 'claude' as const },
      { id: `${id}-img`, type: 'image' as const, x: x + 20, y: y + 20, width: 720, height: 450, by: 'claude' as const, frameId: id },
    ];
  const board = (elements: ReadResponse['elements'], bounds = { x: 0, y: 0, width: 0, height: 0 }): ReadResponse => ({ board: 'b', elements, bounds });

  it('starts at the origin of an empty board, else below what is there', () => {
    expect(nextSnapSlot(board([]))).toEqual({ x: 0, y: 0, step: 1 });
    const sketch = [{ id: 'r', type: 'rectangle' as const, x: 40, y: 10, width: 200, height: 80, by: 'user' as const }];
    expect(nextSnapSlot(board(sketch, { x: 40, y: 10, width: 200, height: 80 }))).toEqual({ x: 40, y: 194, step: 1 });
  });

  it('runs three to a row, then starts a row under the tallest', () => {
    expect(nextSnapSlot(board(frame('a', 0, 0)))).toEqual({ x: 840, y: 0, step: 2 });
    const row = [...frame('a', 0, 0), ...frame('b', 840, 0, 600), ...frame('c', 1680, 0)];
    expect(nextSnapSlot(board(row))).toEqual({ x: 0, y: 704, step: 4 });
  });

  it('ignores frames without a picture of Claude\'s', () => {
    const userFrame = [{ id: 'u', type: 'frame' as const, x: 0, y: 0, width: 400, height: 300, by: 'user' as const }];
    expect(nextSnapSlot(board(userFrame, { x: 0, y: 0, width: 400, height: 300 })).step).toBe(1);
  });
});

describe('update and delete', () => {
  it('sends updates as a bare array or wrapped', async () => {
    handler = () => ({ json: { ids: ['a'], batchId: 'u1' } });
    const updates = [{ id: 'a', x: 5, label: 'New', color: 'red' }];
    const r1 = await run(['update'], JSON.stringify(updates));
    const r2 = await run(['update', '--board', 'b'], JSON.stringify({ updates }));
    expect(r1.stdout).toContain('updated 1 element, batch u1');
    expect(seen[0]).toEqual({ method: 'PATCH', url: '/boards/current/elements', body: { updates } });
    expect(seen[1].url).toBe('/boards/b/elements');
    expect(r2.code).toBe(0);
  });

  it('names the index of a bad update', async () => {
    const r = await run(['update'], JSON.stringify([{ id: 'a' }, { x: 3 }]));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('updates[1]: "id"');
    expect(seen).toHaveLength(0);
  });

  it('deletes ids and reports unknown ones', async () => {
    handler = () => ({ json: { ids: ['a'], batchId: 'd1' } });
    const r = await run(['delete', '--board', 'b', 'a', 'zz']);
    expect(seen[0]).toEqual({ method: 'DELETE', url: '/boards/b/elements', body: { ids: ['a', 'zz'] } });
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
    await new Promise((ok) => server.close(ok));
    for (const argv of [['status'], ['read'], ['png'], ['boards']]) {
      const r = await run(argv);
      expect(r.code).toBe(3);
      expect(r.stderr).toBe('Agent Brief is not running. Start it, or run /sketch in Claude Code.\n');
    }
    server = http.createServer();
    await new Promise<void>((ok) => server.listen(socket, ok));
  });

  it('exits 3 for a socket file with no listener', async () => {
    await new Promise((ok) => server.close(ok));
    const missing = path.join(dir, 'missing.sock');
    let stderr = '';
    const code = await main(['status'], { stdin: async () => '', stdout() {}, stderr: (s) => (stderr += s), env: { COMPANION_SOCKET: missing } });
    expect(code).toBe(3);
    expect(stderr).toContain('not running');
    server = http.createServer();
    await new Promise<void>((ok) => server.listen(socket, ok));
  });

  it('prints a generic message for a non-JSON error body', async () => {
    handler = () => ({ status: 500, raw: Buffer.from('boom'), type: 'text/plain' });
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
    expect(seen).toHaveLength(0);
  });

  it('rejects unknown commands and options', async () => {
    expect((await run(['wat'])).code).toBe(2);
    const r = await run(['read', '--bogus']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--bogus');
  });
});

describe('built binary', () => {
  it('runs bin/agent-brief.mjs against the fake server', async () => {
    handler = () => ({ json: { ids: ['a'], batchId: 'bb' } });
    const bin = path.resolve(__dirname, '../bin/agent-brief.mjs');
    const result = await new Promise<{ code: number; stdout: string }>((ok) => {
      const child = execFile(
        'node', [bin, 'draw'],
        { env: { ...process.env, COMPANION_SOCKET: socket } },
        (error, stdout) => ok({ code: error ? (error as { code?: number }).code ?? 1 : 0, stdout }),
      );
      child.stdin!.end('[{"type":"text","label":"hi","x":0,"y":0}]');
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('batch bb');
    expect(seen[0].body).toEqual({ elements: [{ type: 'text', label: 'hi', x: 0, y: 0 }] });
  });

  it('exits 3 when the app is not running', async () => {
    const bin = path.resolve(__dirname, '../bin/agent-brief.mjs');
    const result = await new Promise<{ code: number; stderr: string }>((ok) => {
      execFile('node', [bin, 'status'], { env: { ...process.env, COMPANION_SOCKET: path.join(dir, 'none.sock') } },
        (error, _o, stderr) => ok({ code: (error as { code?: number } | null)?.code ?? 0, stderr }));
    });
    expect(result.code).toBe(3);
    expect(result.stderr).toContain('not running');
  });
});

describe('bin/agent-brief wrapper', () => {
  const wrapper = path.resolve(__dirname, '../bin/agent-brief');

  function exec(file: string, args: string[], stdin?: string) {
    return new Promise<{ code: number; stdout: string }>((ok) => {
      const child = execFile(file, args, { env: { ...process.env, COMPANION_SOCKET: socket } },
        (error, stdout) => ok({ code: (error as { code?: number } | null)?.code ?? 0, stdout }));
      child.stdin!.end(stdin ?? '');
    });
  }

  it('runs through a symlink, as ~/.local/bin/agent-brief does', async () => {
    handler = () => ({ json: { ids: ['a'], batchId: 'bb' } });
    const link = path.join(dir, 'agent-brief');
    fs.symlinkSync(wrapper, link);
    const result = await exec(link, ['draw'], '[{"type":"text","label":"hi","x":0,"y":0}]');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('batch bb');
  });

  it("uses the app's Electron as Node inside a bundle", async () => {
    const contents = path.join(dir, 'X.app', 'Contents');
    fs.mkdirSync(path.join(contents, 'Resources', 'bin'), { recursive: true });
    fs.mkdirSync(path.join(contents, 'MacOS'));
    fs.copyFileSync(wrapper, path.join(contents, 'Resources', 'bin', 'agent-brief'));
    const electron = path.join(contents, 'MacOS', 'Agent Brief');
    fs.writeFileSync(electron, '#!/bin/sh\necho "run-as-node=$ELECTRON_RUN_AS_NODE $*"\n', { mode: 0o755 });
    const link = path.join(dir, 'agent-brief');
    fs.symlinkSync(path.join(contents, 'Resources', 'bin', 'agent-brief'), link);

    const result = await exec(link, ['status']);
    expect(result.stdout.trim()).toBe(`run-as-node=1 ${path.join(contents, 'Resources', 'bin', 'agent-brief.mjs')} status`);
  });
});
