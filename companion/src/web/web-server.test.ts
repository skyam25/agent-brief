import http from 'node:http';
import net from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import type { Delivery } from '../protocol';
import { DEVICE_TTL_MS } from './pairing';
import { MAX_SOCKETS_PER_DEVICE, SEND_RATE, WS_RATE } from './limits';
import {
  bearerCredential,
  createWebServer,
  defaultAllow,
  guardConnection,
  protocolCredential,
  type Destination,
  type WebServer,
} from './web-server';
import { SyncHub } from './sync-hub';

const running: WebServer[] = [];
afterEach(async () => {
  vi.useRealTimers();
  while (running.length) await running.pop()!.stop();
});

const delivery: Delivery = { id: 'd1', sessionId: 's', dir: '/x', draft: '', mode: 'fill', createdAt: 0 };
const ALPHA: Destination = { sessionId: 's', label: 'Alpha' };
const DAY = 24 * 3600_000;

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
  const dest: { current: Destination | undefined } = { current: ALPHA };
  const devicesFile = join(dir, 'devices.json');
  const server = createWebServer({
    host: '127.0.0.1',
    port: 0,
    staticDir,
    devicesFile,
    hub,
    deliver,
    destination: () => dest.current,
    now: () => clock.t,
    ...over,
  });
  running.push(server);
  const { port } = await server.start();
  return { dir, staticDir, devicesFile, hub, deliver, clock, dest, server, port };
}

type Setup = Awaited<ReturnType<typeof setup>>;

interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
  json: any;
}

function get(
  port: number,
  path: string,
  opts: { auth?: string; method?: string; body?: unknown; ua?: string; headers?: Record<string, string> } = {},
) {
  return new Promise<Res>((resolve, reject) => {
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: opts.method ?? (payload ? 'POST' : 'GET'),
        agent: false,
        headers: {
          ...(opts.auth ? { Authorization: `Bearer ${opts.auth}` } : {}),
          ...(opts.ua ? { 'User-Agent': opts.ua } : {}),
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...opts.headers,
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

/** The one-use code in a pairing URL's fragment. */
const codeOf = (url: string) => new URLSearchParams(new URL(url).hash.slice(1)).get('pair')!;

/** Redeems a code the way the page does. */
const redeem = (s: Setup, code: string, opts: { ua?: string; headers?: Record<string, string> } = {}) =>
  get(s.port, '/api/pair', { body: { token: code }, ...opts });

/** Pairs a device and returns its credential. */
async function pair(s: Setup, ua?: string): Promise<string> {
  const { url } = await s.server.newPairingUrl();
  const r = await redeem(s, codeOf(url), { ua });
  expect(r.status).toBe(200);
  return r.json.credential;
}

const protocols = (credential: string) => ['agent-brief', `auth.${credential}`];

function connectWs(s: Setup, board: string, credential?: string) {
  s.hub.local(board, []);
  const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws?board=${board}`, credential ? protocols(credential) : []);
  const messages: any[] = [];
  ws.on('message', (d) => messages.push(JSON.parse(String(d))));
  const opened = new Promise<void>((res, rej) => {
    ws.once('open', () => res());
    ws.once('error', rej);
    ws.once('unexpected-response', (_req, r) => rej(new Error(`status ${r.statusCode}`)));
  });
  return { ws, messages, opened };
}

/** The status a refused upgrade answers with. */
function upgradeStatus(ws: WebSocket): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    ws.once('unexpected-response', (_req, response) => resolve(response.statusCode!));
    ws.once('open', () => {
      ws.terminate();
      reject(new Error('connected'));
    });
    ws.once('error', () => undefined);
  });
}

const waitFor = async (cond: () => boolean, ms = 500) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};

const el = (id: string, version = 1, versionNonce = 1) => ({ id, version, versionNonce });
const sendBody = (over: Record<string, unknown> = {}) => ({ board: 'b', png: 'AAAA', scene: {}, sessionId: 's', ...over });

describe('C6.1 auth', () => {
  it('answers 401 on the API and the WebSocket without a credential', async () => {
    const s = await setup();
    const cases: [string, string, unknown?][] = [
      ['GET', '/api/boards'],
      ['GET', '/api/boards/main'],
      ['POST', '/api/send', sendBody()],
      ['POST', '/api/pair', {}],
      ['POST', '/api/pair', { token: 'bogus' }],
    ];
    for (const [method, path, body] of cases) {
      const r = await get(s.port, path, { method, body });
      expect(r.status, `${method} ${path}`).toBe(401);
      expect(r.json.code).toBe('unauthorized');
    }
    expect(s.deliver).not.toHaveBeenCalled();
    await expect(connectWs(s, 'b').opened).rejects.toThrow(/401/);
  });

  it('serves the client files to the allowed network without a credential', async () => {
    const s = await setup();
    expect((await get(s.port, '/')).text).toBe('<h1>board</h1>');
    expect((await get(s.port, '/app.js')).status).toBe(200);
    expect((await get(s.port, '/nope')).status).toBe(404);
    expect((await get(s.port, '/', { method: 'POST' })).status).toBe(404);
  });

  it('rejects a forged or tampered credential, and ignores cookies', async () => {
    const s = await setup();
    const credential = await pair(s);
    const [id, secret] = credential.split('.');
    for (const bad of [`${id}.${secret}x`, `${id}.`, `nope.${secret}`, secret]) {
      expect((await get(s.port, '/api/boards', { auth: bad })).status, bad).toBe(401);
    }
    expect((await get(s.port, '/api/boards', { headers: { Authorization: `Basic ${credential}` } })).status).toBe(401);
    expect((await get(s.port, '/api/boards', { headers: { Cookie: `companion_device=${credential}` } })).status).toBe(401);
    expect((await get(s.port, '/api/boards', { auth: credential })).status).toBe(200);
  });

  it('trades a code once for a credential and sets no cookie', async () => {
    const s = await setup();
    const { url } = await s.server.newPairingUrl();
    expect(url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${s.port}/#pair=[\\w-]{43}$`));

    const first = await redeem(s, codeOf(url), { ua: 'Mozilla/5.0 (iPad; CPU OS 17_0) AppleWebKit Version/17 Safari/605.1' });
    expect(first.status).toBe(200);
    expect(first.json.credential).toMatch(/^[\w-]+\.[\w-]+$/);
    expect(first.headers['set-cookie']).toBeUndefined();
    expect(first.headers['cache-control']).toBe('no-store');

    expect((await redeem(s, codeOf(url))).status).toBe(401);
    expect((await get(s.port, '/api/boards', { auth: first.json.credential })).status).toBe(200);
    expect(s.server.devices()).toMatchObject([{ name: 'iPad (Safari)' }]);
  });

  it('rejects an expired code', async () => {
    const s = await setup();
    const { url } = await s.server.newPairingUrl();
    s.clock.t += 10 * 60_000 + 1;
    expect((await redeem(s, codeOf(url))).status).toBe(401);
  });

  it('invalidates the previous QR code when a new code is generated', async () => {
    const s = await setup();
    const old = codeOf((await s.server.newPairingUrl()).url);
    const fresh = codeOf((await s.server.newPairingUrl()).url);
    expect((await redeem(s, old)).status).toBe(401);
    expect((await redeem(s, fresh)).status).toBe(200);
  });

  it('rejects an untrusted Host before redeeming a pairing code or serving boards', async () => {
    const s = await setup();
    const code = codeOf((await s.server.newPairingUrl()).url);
    expect((await redeem(s, code, { headers: { Host: 'attacker.example' } })).status).toBe(403);
    expect((await get(s.port, '/', { headers: { Host: 'attacker.example' } })).status).toBe(403);
    const paired = await redeem(s, code);
    expect(paired.status).toBe(200);
    const credential = paired.json.credential;
    expect((await get(s.port, '/api/boards', { auth: credential, headers: { Host: 'attacker.example' } })).status).toBe(403);
    s.hub.local('b', []);
    const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws?board=b`, protocols(credential), {
      headers: { Host: 'attacker.example' },
    });
    expect(await upgradeStatus(ws)).toBe(403);
  });

  it('accepts a code just before it expires', async () => {
    const s = await setup();
    const { url } = await s.server.newPairingUrl();
    s.clock.t += 10 * 60_000 - 1;
    expect((await redeem(s, codeOf(url))).status).toBe(200);
  });

  it('401s a revoked device on its next request and closes its socket', async () => {
    const s = await setup();
    const credential = await pair(s);
    const c = connectWs(s, 'b', credential);
    await c.opened;
    const closed = new Promise<number>((res) => c.ws.once('close', (code) => res(code)));

    const [device] = s.server.devices();
    expect(s.server.revoke(device.id)).toBe(true);
    expect(await closed).toBe(4001);
    expect((await get(s.port, '/api/boards', { auth: credential })).status).toBe(401);
    expect(s.server.devices()).toEqual([]);
  });

  it('keeps paired devices across a restart', async () => {
    const s = await setup();
    const credential = await pair(s);
    await s.server.stop();
    const again = createWebServer({
      host: '127.0.0.1',
      port: 0,
      staticDir: s.staticDir,
      devicesFile: s.devicesFile,
      hub: new SyncHub(),
      deliver: s.deliver,
      destination: () => ALPHA,
      now: () => s.clock.t,
    });
    running.push(again);
    const { port } = await again.start();
    expect((await get(port, '/api/boards', { auth: credential })).status).toBe(200);
    // The file stores a hash, never the secret.
    expect(readFileSync(s.devicesFile, 'utf8')).not.toContain(credential.split('.')[1]);
  });

  it('forgets a device 30 days after its last use', async () => {
    const s = await setup();
    const credential = await pair(s);
    s.clock.t += DEVICE_TTL_MS - DAY;
    expect((await get(s.port, '/api/boards', { auth: credential })).status).toBe(200);
    s.clock.t += DEVICE_TTL_MS - DAY;
    expect((await get(s.port, '/api/boards', { auth: credential })).status).toBe(200);
    s.clock.t += DEVICE_TTL_MS + 1;
    expect((await get(s.port, '/api/boards', { auth: credential })).status).toBe(401);
    expect(s.server.devices()).toEqual([]);
    expect(JSON.parse(readFileSync(s.devicesFile, 'utf8')).devices).toEqual([]);
  });

  it('drops an expired device from the list and closes its socket on its next message', async () => {
    const s = await setup();
    const credential = await pair(s);
    const c = connectWs(s, 'main', credential);
    await c.opened;
    const closed = new Promise<number>((res) => c.ws.once('close', (code) => res(code)));
    s.clock.t += DEVICE_TTL_MS + 1;
    c.ws.send(JSON.stringify({ type: 'update', elements: [el('late')] }));
    expect(await closed).toBe(4001);
    expect(s.hub.snapshot('main')).toEqual([]);
    expect(s.server.devices()).toEqual([]);
  });

  it('drops devices paired under the old cookie file format', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'web'));
    const devicesFile = join(dir, 'devices.json');
    writeFileSync(devicesFile, JSON.stringify([{ id: 'old', name: 'iPad', firstSeen: 1, lastSeen: 1, secretHash: 'ab' }]));
    const s = await setup({ devicesFile, now: () => 2 });
    expect(s.server.devices()).toEqual([]);
  });
});

describe('credential parsing', () => {
  it('reads a bearer header and nothing else', () => {
    expect(bearerCredential('Bearer abc.def')).toBe('abc.def');
    expect(bearerCredential('bearer abc.def')).toBeUndefined();
    expect(bearerCredential('Basic abc.def')).toBeUndefined();
    expect(bearerCredential('Bearer a b')).toBeUndefined();
    expect(bearerCredential(undefined)).toBeUndefined();
  });

  it('reads the auth subprotocol only next to ours', () => {
    expect(protocolCredential('agent-brief, auth.abc.def')).toBe('abc.def');
    expect(protocolCredential('auth.abc.def')).toBeUndefined();
    expect(protocolCredential('agent-brief')).toBeUndefined();
    expect(protocolCredential('agent-brief, auth.')).toBeUndefined();
    expect(protocolCredential(undefined)).toBeUndefined();
  });
});

describe('serving', () => {
  it('serves static files with security headers', async () => {
    const s = await setup();
    const page = await get(s.port, '/');
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
    expect((await get(s.port, '/app.js')).headers['content-type']).toContain('javascript');
    expect((await get(s.port, '/missing.css')).status).toBe(404);
  });

  it('blocks path traversal', async () => {
    const s = await setup();
    for (const path of ['/%2e%2e/secret.txt', '/..%2fsecret.txt', '/%00']) {
      const r = await get(s.port, path);
      expect([400, 404], path).toContain(r.status);
      expect(r.text).not.toContain('secret');
    }
  });

  it('lists and returns boards from the hub', async () => {
    const s = await setup();
    const auth = await pair(s);
    s.hub.local('main', [el('a'), { ...el('b'), isDeleted: true }]);
    expect((await get(s.port, '/api/boards', { auth })).json).toEqual({
      boards: [{ name: 'main', elementCount: 1 }],
      destination: ALPHA,
    });
    const board = await get(s.port, '/api/boards/main', { auth });
    expect(board.json.board).toBe('main');
    expect(board.json.elements).toHaveLength(2);
    expect((await get(s.port, '/api/boards/none', { auth })).status).toBe(404);
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
        destination: () => ALPHA,
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
  it('delivers to the session the iPad named and says where it went', async () => {
    const s = await setup();
    const auth = await pair(s);
    const scene = { elements: [{ id: 'a' }] };
    const r = await get(s.port, '/api/send', {
      auth,
      body: sendBody({ board: 'idea', png: Buffer.from('PNG!').toString('base64'), scene, notes: 'hi' }),
    });
    expect(r.json).toEqual({ ok: true, id: 'd1', sessionId: 's', to: 'Alpha' });
    expect(s.deliver).toHaveBeenCalledTimes(1);
    const input = (s.deliver.mock.calls[0] as unknown as [any])[0];
    expect(input.png.toString()).toBe('PNG!');
    expect(input).toMatchObject({ scene, boardName: 'idea', notes: 'hi', sessionId: 's' });
  });

  it('refuses with 409 and the new destination when the Mac chose another session', async () => {
    const s = await setup();
    const auth = await pair(s);
    s.dest.current = { sessionId: 't', label: 'Beta' };
    const r = await get(s.port, '/api/send', { auth, body: sendBody() });
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ code: 'conflict', destination: { sessionId: 't', label: 'Beta' } });
    expect(r.json.error).toMatch(/now sends to Beta/);
    const unnamed = await get(s.port, '/api/send', { auth, body: sendBody({ sessionId: undefined }) });
    expect(unnamed.status).toBe(409);
    expect(s.deliver).not.toHaveBeenCalled();
  });

  it('refuses with 409 when no session is chosen on the Mac', async () => {
    const s = await setup();
    const auth = await pair(s);
    s.dest.current = undefined;
    const r = await get(s.port, '/api/send', { auth, body: sendBody() });
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ destination: null, error: 'Choose a Claude Code session on the Mac first.' });
    expect(s.deliver).not.toHaveBeenCalled();
  });

  it('answers 400 for bad bodies and 409 when delivery fails', async () => {
    const s = await setup();
    const auth = await pair(s);
    for (const body of [{}, sendBody({ png: '' }), sendBody({ scene: undefined }), sendBody({ notes: 3 }), sendBody({ sessionId: 3 })]) {
      const r = await get(s.port, '/api/send', { auth, body });
      expect(r.status, JSON.stringify(body)).toBe(400);
      s.clock.t += 60_000;
    }
    s.deliver.mockRejectedValueOnce(new Error('no Claude Code session'));
    const r = await get(s.port, '/api/send', { auth, body: sendBody() });
    expect(r.status).toBe(409);
    expect(r.json.error).toMatch(/no Claude Code session/);
  });

  it('limits sends per device', async () => {
    const s = await setup();
    const auth = await pair(s);
    const other = await pair(s);
    for (let i = 0; i < SEND_RATE.burst; i++) {
      expect((await get(s.port, '/api/send', { auth, body: sendBody() })).status).toBe(200);
    }
    const refused = await get(s.port, '/api/send', { auth, body: sendBody() });
    expect(refused.status).toBe(429);
    expect(refused.json.error).toMatch(/Too many sends/);
    expect((await get(s.port, '/api/send', { auth: other, body: sendBody() })).status).toBe(200);
    s.clock.t += 1000 / SEND_RATE.perSecond;
    expect((await get(s.port, '/api/send', { auth, body: sendBody() })).status).toBe(200);
  });

  it('refuses a body over the Send cap', async () => {
    const s = await setup();
    const auth = await pair(s);
    const r = await get(s.port, '/api/send', { auth, body: sendBody({ notes: 'x'.repeat(21 * 1024 * 1024) }) }).catch(
      () => ({ status: 400 }) as Res,
    );
    expect(r.status).toBe(400);
    expect(s.deliver).not.toHaveBeenCalled();
  });
});

describe('optional app hooks', () => {
  it('adds current to the board list', async () => {
    const s = await setup({ current: () => 'idea' });
    const auth = await pair(s);
    expect((await get(s.port, '/api/boards', { auth })).json).toEqual({ boards: [], current: 'idea', destination: ALPHA });
    s.dest.current = undefined;
    expect((await get(s.port, '/api/boards', { auth })).json.destination).toBeNull();
  });
});

describe('sync over WebSocket', () => {
  it('refuses unknown and unsafe board names without adding them to the hub', async () => {
    const s = await setup();
    const credential = await pair(s);
    for (const board of ['missing', '../../outside', 'x'.repeat(100)]) {
      const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws?board=${encodeURIComponent(board)}`, protocols(credential));
      expect(await upgradeStatus(ws)).toBe(404);
      expect(s.hub.has(board)).toBe(false);
    }
  });

  it('rejects malformed upgrade URLs and keeps serving', async () => {
    const s = await setup();
    const response = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(s.port, '127.0.0.1');
      let data = '';
      socket.setTimeout(1000, () => { socket.destroy(); reject(new Error('upgrade timed out')); });
      socket.once('connect', () => socket.write(`GET http://[ HTTP/1.1\r\nHost: 127.0.0.1:${s.port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`));
      socket.on('data', (chunk) => { data += chunk; });
      socket.once('end', () => resolve(data));
      socket.once('error', reject);
    });
    expect(response).toContain('400 Bad Request');
    expect((await get(s.port, '/api/boards', { auth: await pair(s) })).status).toBe(200);
  });

  it('takes the credential from the subprotocol and answers with ours alone', async () => {
    const s = await setup();
    const credential = await pair(s);
    const c = connectWs(s, 'b', credential);
    await c.opened;
    expect(c.ws.protocol).toBe('agent-brief');
    const cookieOnly = new WebSocket(`ws://127.0.0.1:${s.port}/ws?board=b`, { headers: { Cookie: `companion_device=${credential}` } });
    expect(await upgradeStatus(cookieOnly)).toBe(401);
    const authOnly = new WebSocket(`ws://127.0.0.1:${s.port}/ws?board=b`, [`auth.${credential}`]);
    expect(await upgradeStatus(authOnly)).toBe(401);
  });

  it('sends the destination on connect and when it changes', async () => {
    const s = await setup();
    const c = connectWs(s, 'main', await pair(s));
    await c.opened;
    await waitFor(() => c.messages.some((m) => m.type === 'destination'));
    expect(c.messages.find((m) => m.type === 'destination')).toEqual({ type: 'destination', destination: ALPHA });
    s.dest.current = undefined;
    s.server.destinationChanged();
    await waitFor(() => c.messages.at(-1)?.destination === null);
  });

  it('relays between two clients and the Mac within 500 ms', async () => {
    const s = await setup();
    const a = connectWs(s, 'main', await pair(s));
    const b = connectWs(s, 'main', await pair(s));
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
    const a = connectWs(s, 'main', await pair(s));
    const b = connectWs(s, 'main', await pair(s));
    await Promise.all([a.opened, b.opened]);
    a.ws.send(JSON.stringify({ type: 'update', elements: [el('p')] }));
    b.ws.send(JSON.stringify({ type: 'update', elements: [el('q')] }));
    await waitFor(() => a.messages.some((m) => m.elements?.[0]?.id === 'q') && b.messages.some((m) => m.elements?.[0]?.id === 'p'));
    expect(s.hub.snapshot('main').map((e) => e.id).sort()).toEqual(['p', 'q']);
  });

  it('ignores malformed frames and invalid elements', async () => {
    const s = await setup();
    const a = connectWs(s, 'main', await pair(s));
    await a.opened;
    a.ws.send('not json');
    a.ws.send(JSON.stringify({ type: 'update', elements: [{ id: 'x' }, el('ok')] }));
    await waitFor(() => s.hub.snapshot('main').length === 1);
    expect(s.hub.snapshot('main')[0].id).toBe('ok');
  });

  it('closes a socket that sends faster than the message limit', async () => {
    const s = await setup();
    const a = connectWs(s, 'main', await pair(s));
    await a.opened;
    const closed = new Promise<number>((res) => a.ws.once('close', (code) => res(code)));
    for (let i = 0; i <= WS_RATE.burst; i++) a.ws.send(JSON.stringify({ type: 'update', elements: [el(`e${i}`)] }));
    expect(await closed).toBe(4008);
    expect(s.hub.snapshot('main')).toHaveLength(WS_RATE.burst);
  });

  it('caps open sockets per device', async () => {
    const s = await setup();
    const credential = await pair(s);
    const open = Array.from({ length: MAX_SOCKETS_PER_DEVICE }, () => connectWs(s, 'main', credential));
    await Promise.all(open.map((c) => c.opened));
    const extra = new WebSocket(`ws://127.0.0.1:${s.port}/ws?board=main`, protocols(credential));
    expect(await upgradeStatus(extra)).toBe(429);
    await connectWs(s, 'main', await pair(s)).opened;
  });
});

describe('C6.5 stop', () => {
  it('closes every socket and the port refuses connections', async () => {
    const s = await setup();
    const c = connectWs(s, 'main', await pair(s));
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

  it('reports the address it turned away, once per address', async () => {
    const s = await setup({ allowRemote: () => false });
    const seen: (string | undefined)[] = [];
    s.server.onChange((st) => seen.push(st.refused));
    for (let i = 0; i < 2; i++) {
      const sock = net.connect(s.port, '127.0.0.1');
      sock.on('error', () => undefined);
      await new Promise((r) => sock.once('close', r));
    }
    expect(seen).toEqual(['127.0.0.1']);
  });

  it('allows loopback by default', async () => {
    const s = await setup();
    expect((await get(s.port, '/api/boards', { auth: await pair(s) })).status).toBe(200);
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
    const credential = await pair(s);
    await vi.advanceTimersByTimeAsync(7 * HOUR);
    await get(s.port, '/api/boards', { auth: credential });
    await vi.advanceTimersByTimeAsync(7 * HOUR);
    expect(await refused(s.port)).toBe(false);

    const c = connectWs(s, 'main', credential);
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
