import http from 'node:http';
import net from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import type { Delivery } from '../protocol';
import { createWebServer, defaultAllow, guardConnection, originAllowed, type WebServer } from './web-server';
import { SyncHub } from './sync-hub';

const running: WebServer[] = [];
afterEach(async () => {
  vi.useRealTimers();
  while (running.length) await running.pop()!.stop();
});

const delivery: Delivery = { id: 'd1', sessionId: 's', dir: '/x', draft: '', mode: 'fill', createdAt: 0 };

async function setup(over: Partial<Parameters<typeof createWebServer>[0]> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'web'));
  const staticDir = join(dir, 'static');
  mkdirSync(staticDir);
  writeFileSync(join(staticDir, 'index.html'), '<h1>board</h1>');
  writeFileSync(join(staticDir, 'app.js'), 'console.log(1)');
  writeFileSync(join(dir, 'secret.txt'), 'secret');
  const hub = new SyncHub();
  const deliver = vi.fn(async () => delivery);
  const clock = { t: 1_000_000 };
  const devicesFile = join(dir, 'devices.json');
  const server = createWebServer({
    host: '127.0.0.1',
    port: 0,
    staticDir,
    devicesFile,
    hub,
    deliver,
    now: () => clock.t,
    ...over,
  });
  running.push(server);
  const { port } = await server.start();
  return { dir, staticDir, devicesFile, hub, deliver, clock, server, port };
}

interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
  json: any;
}

function get(port: number, path: string, opts: { cookie?: string; method?: string; body?: unknown; ua?: string } = {}) {
  return new Promise<Res>((resolve, reject) => {
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: opts.method ?? 'GET',
        agent: false,
        headers: {
          ...(opts.cookie ? { Cookie: opts.cookie } : {}),
          ...(opts.ua ? { 'User-Agent': opts.ua } : {}),
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json: unknown;
          try {
            json = JSON.parse(text);
          } catch {
            json = undefined;
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
        });
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

/** Pairs a device and returns its cookie. */
async function pair(s: Awaited<ReturnType<typeof setup>>, ua?: string): Promise<string> {
  const { url } = await s.server.newPairingUrl();
  const path = new URL(url).pathname + new URL(url).search;
  const r = await get(s.port, path, { ua });
  expect(r.status).toBe(302);
  return String(r.headers['set-cookie']![0]).split(';')[0];
}

function connectWs(port: number, board: string, cookie?: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?board=${board}`, { headers: cookie ? { Cookie: cookie } : {} });
  const messages: any[] = [];
  ws.on('message', (d) => messages.push(JSON.parse(String(d))));
  const opened = new Promise<void>((res, rej) => {
    ws.once('open', () => res());
    ws.once('error', rej);
    ws.once('unexpected-response', (_req, r) => rej(new Error(`status ${r.statusCode}`)));
  });
  return { ws, messages, opened };
}

const waitFor = async (cond: () => boolean, ms = 500) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};

const el = (id: string, version = 1, versionNonce = 1) => ({ id, version, versionNonce });

describe('C6.1 auth', () => {
  it('answers 401 everywhere without a cookie', async () => {
    const s = await setup();
    const cases: [string, string, unknown?][] = [
      ['GET', '/'],
      ['GET', '/app.js'],
      ['GET', '/index.html'],
      ['GET', '/api/boards'],
      ['GET', '/api/boards/main'],
      ['POST', '/api/send', { board: 'b', png: 'AAAA', scene: {} }],
      ['GET', '/nope'],
      ['GET', '/pair'],
      ['GET', '/pair?token=bogus'],
    ];
    for (const [method, path, body] of cases) {
      const r = await get(s.port, path, { method, body });
      expect(r.status, `${method} ${path}`).toBe(401);
      expect(r.json.code).toBe('unauthorized');
    }
    expect(s.deliver).not.toHaveBeenCalled();
    await expect(connectWs(s.port, 'b').opened).rejects.toThrow(/401/);
  });

  it('rejects a forged or tampered cookie', async () => {
    const s = await setup();
    const cookie = await pair(s);
    const [name, value] = cookie.split('=');
    const [id, secret] = value.split('.');
    for (const bad of [`${name}=${id}.${secret}x`, `${name}=${id}.`, `${name}=nope.${secret}`, `${name}=${secret}`]) {
      expect((await get(s.port, '/', { cookie: bad })).status, bad).toBe(401);
    }
    expect((await get(s.port, '/', { cookie })).status).toBe(200);
  });

  it('accepts a token once, sets a strict HttpOnly cookie and redirects', async () => {
    const s = await setup();
    const { url } = await s.server.newPairingUrl();
    expect(url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${s.port}/pair\\?token=[\\w-]{43}$`));
    const path = new URL(url).pathname + new URL(url).search;

    const first = await get(s.port, path, { ua: 'Mozilla/5.0 (iPad; CPU OS 17_0) AppleWebKit Version/17 Safari/605.1' });
    expect(first.status).toBe(302);
    expect(first.headers.location).toBe('/');
    const cookie = String(first.headers['set-cookie']![0]);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(first.headers['referrer-policy']).toBe('no-referrer');

    expect((await get(s.port, path)).status).toBe(401);
    expect((await get(s.port, '/', { cookie: cookie.split(';')[0] })).status).toBe(200);
    expect(s.server.devices()).toMatchObject([{ name: 'iPad (Safari)' }]);
  });

  it('rejects an expired token', async () => {
    const s = await setup();
    const { url } = await s.server.newPairingUrl();
    s.clock.t += 10 * 60_000 + 1;
    const r = await get(s.port, new URL(url).pathname + new URL(url).search);
    expect(r.status).toBe(401);
  });

  it('accepts a token just before it expires', async () => {
    const s = await setup();
    const { url } = await s.server.newPairingUrl();
    s.clock.t += 10 * 60_000 - 1;
    expect((await get(s.port, new URL(url).pathname + new URL(url).search)).status).toBe(302);
  });

  it('401s a revoked device on its next request and closes its socket', async () => {
    const s = await setup();
    const cookie = await pair(s);
    const c = connectWs(s.port, 'b', cookie);
    await c.opened;
    const closed = new Promise<number>((res) => c.ws.once('close', (code) => res(code)));

    const [device] = s.server.devices();
    expect(s.server.revoke(device.id)).toBe(true);
    expect(await closed).toBe(4001);
    expect((await get(s.port, '/', { cookie })).status).toBe(401);
    expect(s.server.devices()).toEqual([]);
  });

  it('keeps paired devices across a restart', async () => {
    const s = await setup();
    const cookie = await pair(s);
    await s.server.stop();
    const again = createWebServer({
      host: '127.0.0.1',
      port: 0,
      staticDir: s.staticDir,
      devicesFile: s.devicesFile,
      hub: new SyncHub(),
      deliver: s.deliver,
      now: () => s.clock.t,
    });
    running.push(again);
    const { port } = await again.start();
    expect((await get(port, '/', { cookie })).status).toBe(200);
    // The file stores a hash, never the secret.
    expect(readFileSync(s.devicesFile, 'utf8')).not.toContain(cookie.split('.')[1]);
  });
});

describe('serving', () => {
  it('serves static files and security headers to a paired device', async () => {
    const s = await setup();
    const cookie = await pair(s);
    const page = await get(s.port, '/', { cookie });
    expect(page.text).toBe('<h1>board</h1>');
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.headers['x-content-type-options']).toBe('nosniff');
    expect(page.headers['referrer-policy']).toBe('no-referrer');
    const csp = String(page.headers['content-security-policy']);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain('blob:');
    expect(csp).toContain('data:');
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect((await get(s.port, '/app.js', { cookie })).headers['content-type']).toContain('javascript');
    expect((await get(s.port, '/missing.css', { cookie })).status).toBe(404);
  });

  it('blocks path traversal', async () => {
    const s = await setup();
    const cookie = await pair(s);
    for (const path of ['/%2e%2e/secret.txt', '/..%2fsecret.txt', '/%00']) {
      const r = await get(s.port, path, { cookie });
      expect([400, 404], path).toContain(r.status);
      expect(r.text).not.toContain('secret');
    }
  });

  it('lists and returns boards from the hub', async () => {
    const s = await setup();
    const cookie = await pair(s);
    s.hub.local('main', [el('a'), { ...el('b'), isDeleted: true }]);
    expect((await get(s.port, '/api/boards', { cookie })).json).toEqual({
      boards: [{ name: 'main', elementCount: 1 }],
    });
    const board = await get(s.port, '/api/boards/main', { cookie });
    expect(board.json.board).toBe('main');
    expect(board.json.elements).toHaveLength(2);
    expect((await get(s.port, '/api/boards/none', { cookie })).status).toBe(404);
  });

  it('refuses to bind a wildcard or public address', async () => {
    for (const host of ['0.0.0.0', '::', '8.8.8.8']) {
      const dir = mkdtempSync(join(tmpdir(), 'web'));
      const server = createWebServer({
        host,
        port: 0,
        staticDir: dir,
        devicesFile: join(dir, 'd.json'),
        hub: new SyncHub(),
        deliver: async () => delivery,
      });
      await expect(server.start(), host).rejects.toThrow(/refusing to bind/);
    }
  });

  it('draws a QR code for the pairing URL', async () => {
    const s = await setup();
    const { qrSvg } = await s.server.newPairingUrl();
    expect(qrSvg).toMatch(/^<\?xml|^<svg/);
    expect(qrSvg).toContain('<svg');
  });
});

describe('send', () => {
  it('calls deliver with the decoded image, scene and notes', async () => {
    const s = await setup();
    const cookie = await pair(s);
    const scene = { elements: [{ id: 'a' }] };
    const r = await get(s.port, '/api/send', {
      cookie,
      method: 'POST',
      body: { board: 'idea', png: Buffer.from('PNG!').toString('base64'), scene, notes: 'hi' },
    });
    expect(r.json).toEqual({ ok: true, id: 'd1', sessionId: 's' });
    expect(s.deliver).toHaveBeenCalledTimes(1);
    const input = (s.deliver.mock.calls[0] as unknown as [any])[0];
    expect(input.png.toString()).toBe('PNG!');
    expect(input).toMatchObject({ scene, boardName: 'idea', notes: 'hi' });
  });

  it('answers 400 for bad bodies and 409 when delivery fails', async () => {
    const s = await setup();
    const cookie = await pair(s);
    for (const body of [{}, { board: 'b', png: '', scene: {} }, { board: 'b', png: 'AAAA' }, { board: 'b', png: 'AAAA', scene: {}, notes: 3 }]) {
      const r = await get(s.port, '/api/send', { cookie, method: 'POST', body });
      expect(r.status).toBe(400);
    }
    s.deliver.mockRejectedValueOnce(new Error('no Claude Code session'));
    const r = await get(s.port, '/api/send', { cookie, method: 'POST', body: { board: 'b', png: 'AAAA', scene: {} } });
    expect(r.status).toBe(409);
    expect(r.json.error).toMatch(/no Claude Code session/);
  });
});

describe('optional app hooks', () => {
  it('adds current to the board list and a session name to the send reply', async () => {
    const describeSession = vi.fn((id: string) => `name-of-${id}`);
    const s = await setup({ current: () => 'idea', describeSession });
    const cookie = await pair(s);
    expect((await get(s.port, '/api/boards', { cookie })).json).toEqual({ boards: [], current: 'idea' });
    const r = await get(s.port, '/api/send', {
      cookie,
      method: 'POST',
      body: { board: 'b', png: 'AAAA', scene: {} },
    });
    expect(r.json).toEqual({ ok: true, id: 'd1', sessionId: 's', to: 'name-of-s' });
    expect(describeSession).toHaveBeenCalledWith('s');
  });
});

describe('sync over WebSocket', () => {
  it('relays between two clients and the Mac within 500 ms', async () => {
    const s = await setup();
    const a = connectWs(s.port, 'main', await pair(s));
    const b = connectWs(s.port, 'main', await pair(s));
    await Promise.all([a.opened, b.opened]);
    await waitFor(() => a.messages.length > 0 && b.messages.length > 0);
    expect(a.messages[0]).toMatchObject({ type: 'snapshot', board: 'main', elements: [] });

    const t0 = Date.now();
    a.ws.send(JSON.stringify({ type: 'update', elements: [el('stroke1')] }));
    await waitFor(() => b.messages.some((m) => m.type === 'update'));
    expect(Date.now() - t0).toBeLessThan(500);
    expect(b.messages.at(-1).elements).toEqual([el('stroke1')]);
    expect(a.messages.filter((m) => m.type === 'update')).toEqual([]);
    expect(s.hub.snapshot('main')).toHaveLength(1);

    s.hub.local('main', [el('claude1')]);
    await waitFor(() => a.messages.some((m) => m.elements?.[0]?.id === 'claude1') && b.messages.some((m) => m.elements?.[0]?.id === 'claude1'));
  });

  it('keeps simultaneous edits to different elements', async () => {
    const s = await setup();
    const a = connectWs(s.port, 'main', await pair(s));
    const b = connectWs(s.port, 'main', await pair(s));
    await Promise.all([a.opened, b.opened]);
    a.ws.send(JSON.stringify({ type: 'update', elements: [el('p')] }));
    b.ws.send(JSON.stringify({ type: 'update', elements: [el('q')] }));
    await waitFor(() => a.messages.some((m) => m.elements?.[0]?.id === 'q') && b.messages.some((m) => m.elements?.[0]?.id === 'p'));
    expect(s.hub.snapshot('main').map((e) => e.id).sort()).toEqual(['p', 'q']);
  });

  it('ignores malformed frames and invalid elements', async () => {
    const s = await setup();
    const a = connectWs(s.port, 'main', await pair(s));
    await a.opened;
    a.ws.send('not json');
    a.ws.send(JSON.stringify({ type: 'update', elements: [{ id: 'x' }, el('ok')] }));
    await waitFor(() => s.hub.snapshot('main').length === 1);
    expect(s.hub.snapshot('main')[0].id).toBe('ok');
  });

  it('answers 403 to a bad Origin and survives', async () => {
    const s = await setup();
    const cookie = await pair(s);
    for (const origin of ['http://evil.example', 'null', 'garbage', '', `http://127.0.0.1:${s.port + 1}`]) {
      const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws?board=b`, { headers: { Cookie: cookie, Origin: origin } });
      const status = await new Promise<number>((res, rej) => {
        ws.once('unexpected-response', (_req, r) => res(r.statusCode ?? 0));
        ws.once('open', () => rej(new Error('connected')));
        ws.once('error', () => undefined);
      });
      expect(status, origin).toBe(403);
    }
    expect((await get(s.port, '/', { cookie })).status).toBe(200);
  });

  it('accepts a same-origin Origin and a missing one', async () => {
    const s = await setup();
    const cookie = await pair(s);
    const same = new WebSocket(`ws://127.0.0.1:${s.port}/ws?board=b`, {
      headers: { Cookie: cookie, Origin: `http://127.0.0.1:${s.port}` },
    });
    await new Promise((r) => same.once('open', r));
    const none = connectWs(s.port, 'b', cookie);
    await none.opened;
  });
});

describe('originAllowed', () => {
  it('is total', () => {
    expect(originAllowed(undefined, 'h:1')).toBe(true);
    expect(originAllowed('http://h:1', 'h:1')).toBe(true);
    expect(originAllowed('http://h:2', 'h:1')).toBe(false);
    expect(originAllowed('null', 'h:1')).toBe(false);
    expect(originAllowed('', 'h:1')).toBe(false);
    expect(originAllowed('::::', 'h:1')).toBe(false);
  });
});

describe('C6.5 stop', () => {
  it('closes every socket and the port refuses connections', async () => {
    const s = await setup();
    const cookie = await pair(s);
    const c = connectWs(s.port, 'main', cookie);
    await c.opened;
    const idle = net.connect(s.port, '127.0.0.1');
    idle.on('error', () => undefined);
    await new Promise((r) => idle.once('connect', r));
    const wsClosed = new Promise((r) => c.ws.once('close', r));
    const idleClosed = new Promise((r) => idle.once('close', r));

    await s.server.stop();
    await Promise.all([wsClosed, idleClosed]);
    await expect(
      new Promise((res, rej) => {
        const probe = net.connect(s.port, '127.0.0.1');
        probe.once('connect', () => res(undefined));
        probe.once('error', rej);
      }),
    ).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  });

  it('reports state changes', async () => {
    const s = await setup();
    const seen: boolean[] = [];
    s.server.onChange((st) => seen.push(st.running));
    await s.server.stop();
    expect(seen).toEqual([false]);
  });
});

describe('C6.6 subnet guard', () => {
  it('destroys a disallowed socket before reading anything', () => {
    const destroy = vi.fn();
    const allow = (r?: string) => r === '192.168.1.5';
    expect(guardConnection({ remoteAddress: '8.8.8.8', destroy }, allow)).toBe(false);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(guardConnection({ remoteAddress: '192.168.1.5', destroy }, allow)).toBe(true);
    expect(guardConnection({ remoteAddress: undefined, destroy }, allow)).toBe(false);
    expect(destroy).toHaveBeenCalledTimes(2);
  });

  it('closes an outside connection without a response, for HTTP and upgrades', async () => {
    const s = await setup({ allowRemote: () => false });
    for (const request of ['GET / HTTP/1.1\r\nHost: x\r\n\r\n', 'GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n']) {
      const sock = net.connect(s.port, '127.0.0.1');
      const received: Buffer[] = [];
      sock.on('data', (d: Buffer) => received.push(d));
      sock.on('error', () => undefined);
      sock.write(request);
      await new Promise((r) => sock.once('close', r));
      expect(Buffer.concat(received).length).toBe(0);
    }
  });

  it('allows loopback by default', async () => {
    const s = await setup();
    const cookie = await pair(s);
    expect((await get(s.port, '/', { cookie })).status).toBe(200);
  });
});

describe('default subnet guard', () => {
  const table = {
    lo0: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', mac: '', internal: true, cidr: null }],
    en0: [{ address: '192.168.1.23', netmask: '255.255.255.0', family: 'IPv4', mac: '', internal: false, cidr: null }],
    en1: [{ address: '10.0.0.5', netmask: '255.0.0.0', family: 'IPv4', mac: '', internal: false, cidr: null }],
  } as Parameters<typeof defaultAllow>[1];

  it('allows the host subnet and loopback only', () => {
    const allow = defaultAllow('192.168.1.23', table);
    expect(allow('192.168.1.99')).toBe(true);
    expect(allow('::ffff:192.168.1.99')).toBe(true);
    expect(allow('127.0.0.1')).toBe(true);
    expect(allow('::1')).toBe(true);
    expect(allow('::ffff:127.0.0.1')).toBe(true);
    expect(allow('192.168.2.1')).toBe(false);
    expect(allow('::ffff:192.168.2.1')).toBe(false);
    expect(allow('10.0.0.9')).toBe(false);
    expect(allow('8.8.8.8')).toBe(false);
    expect(allow('2001:db8::1')).toBe(false);
    expect(allow(undefined)).toBe(false);
  });

  it('follows the interface that owns the host', () => {
    const allow = defaultAllow('10.0.0.5', table);
    expect(allow('10.9.9.9')).toBe(true);
    expect(allow('192.168.1.99')).toBe(false);
  });

  it('allows loopback only for a host no interface owns', () => {
    const allow = defaultAllow('127.0.0.1', table);
    expect(allow('127.0.0.1')).toBe(true);
    expect(allow('192.168.1.99')).toBe(false);
  });

  it('is wired into createWebServer when allowRemote is absent', async () => {
    const s = await setup();
    expect(s.server.allows('127.0.0.1')).toBe(true);
    expect(s.server.allows('8.8.8.8')).toBe(false);
    expect(s.server.allows('192.168.1.99')).toBe(false);
    expect(s.server.allows(undefined)).toBe(false);
  });

  it('closes a real connection when the injected check refuses it', async () => {
    const s = await setup({ allowRemote: (r) => r === '203.0.113.9' });
    const sock = net.connect(s.port, '127.0.0.1');
    sock.on('error', () => undefined);
    await new Promise((r) => sock.once('close', r));
    expect(s.server.allows('203.0.113.9')).toBe(true);
  });
});

describe('idle shutdown', () => {
  const refused = (port: number) =>
    new Promise<boolean>((res) => {
      const probe = net.connect(port, '127.0.0.1');
      probe.once('connect', () => {
        probe.destroy();
        res(false);
      });
      probe.once('error', () => res(true));
    });

  const HOUR = 3600_000;

  it('turns off after 8 hours with no client', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const s = await setup();
    const states: boolean[] = [];
    s.server.onChange((st) => states.push(st.running));
    await vi.advanceTimersByTimeAsync(8 * HOUR - 1);
    expect(states).toEqual([]);
    await vi.advanceTimersByTimeAsync(2);
    expect(states).toEqual([false]);
    vi.useRealTimers();
    expect(await refused(s.port)).toBe(true);
  });

  it('restarts the countdown on activity and holds while a socket is open', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const s = await setup();
    const cookie = await pair(s);
    await vi.advanceTimersByTimeAsync(7 * HOUR);
    await get(s.port, '/', { cookie });
    await vi.advanceTimersByTimeAsync(7 * HOUR);
    expect(await refused(s.port)).toBe(false);

    const c = connectWs(s.port, 'main', cookie);
    await c.opened;
    await vi.advanceTimersByTimeAsync(20 * HOUR);
    expect(await refused(s.port)).toBe(false);

    c.ws.close();
    await new Promise((r) => c.ws.once('close', r));
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    await vi.advanceTimersByTimeAsync(8 * HOUR + 1);
    vi.useRealTimers();
    expect(await refused(s.port)).toBe(true);
  });
});
