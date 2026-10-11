/**
 * LAN web server for the iPad client. It binds to one private or loopback
 * address, drops connections from outside the subnet before reading a byte,
 * and serves only devices that hold a paired cookie.
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import type { Duplex } from 'node:stream';
import net from 'node:net';
import { networkInterfaces } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import QRCode from 'qrcode';
import { WebSocket, WebSocketServer } from 'ws';
import type { Delivery } from '../protocol';
import type { DeliveryInput } from '../server/contract';
import { isLoopback, isPrivateIpv4, isSameSubnet, pickLanInterface, stripMapped } from './lan';
import { PairingStore, type DeviceInfo } from './pairing';
import { isSyncElement, type HubClient, type SyncElement, type SyncHub } from './sync-hub';

export const DEFAULT_PORT = 47613;
const DEFAULT_IDLE_OFF_MS = 8 * 3600_000;
const MAX_BODY_BYTES = 20 * 1024 * 1024;

export interface WebServerOptions {
  /** A private IPv4 address or loopback. Wildcard and public addresses are refused. */
  host: string;
  port: number;
  staticDir: string;
  devicesFile: string;
  hub: SyncHub;
  deliver: (input: DeliveryInput) => Promise<Delivery>;
  now?: () => number;
  idleOffMs?: number;
  /** The board the Mac shows now. Added to `GET /api/boards` as `current`. */
  current?: () => string;
  /** Names a session for the Send reply, such as its title or folder name. */
  describeSession?: (sessionId: string) => string;
  /**
   * Decides whether a remote address may connect. The default accepts loopback
   * and the subnet of the interface that owns `host`.
   */
  allowRemote?: (remote: string | undefined) => boolean;
}

export interface WebServerState {
  running: boolean;
  devices: DeviceInfo[];
  /** The last address turned away for being outside the allowed network. */
  refused?: string;
}

export interface WebServer {
  /** Resolves with the bound address. */
  start(): Promise<{ host: string; port: number }>;
  stop(): Promise<void>;
  newPairingUrl(): Promise<{ url: string; qrSvg: string }>;
  devices(): DeviceInfo[];
  revoke(id: string): boolean;
  /** Whether a remote address may connect. The same check runs on every new socket. */
  allows(remote: string | undefined): boolean;
  /** Fires when the server starts or stops and when the device list changes. */
  onChange(fn: (state: WebServerState) => void): () => void;
}

interface WebError {
  error: string;
  code: 'unauthorized' | 'not_found' | 'bad_request' | 'conflict' | 'internal';
}

const STATUS: Record<WebError['code'], number> = {
  unauthorized: 401,
  not_found: 404,
  bad_request: 400,
  conflict: 409,
  internal: 500,
};

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.map': 'application/json',
};

/** Destroys a socket whose remote address is not allowed. Returns whether it was kept. */
export function guardConnection(
  socket: { remoteAddress?: string; destroy(): void },
  allow: (remote: string | undefined) => boolean,
): boolean {
  if (allow(socket.remoteAddress)) return true;
  socket.destroy();
  return false;
}

class HttpFailure extends Error {
  constructor(readonly code: WebError['code'], message: string) {
    super(message);
  }
}

function securityHeaders(host: string | undefined): Record<string, string> {
  const safeHost = host && /^[\w.\-:[\]]+$/.test(host) ? host : undefined;
  const connect = ["'self'", ...(safeHost ? [`ws://${safeHost}`] : [])].join(' ');
  return {
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self' 'wasm-unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      `connect-src ${connect}`,
      "worker-src 'self' blob:",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; '),
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  };
}

/**
 * The default connection check. It allows loopback and the subnet of the
 * interface that owns `host`. A host that no interface owns allows loopback only.
 */
export function defaultAllow(
  host: string,
  interfaces: Parameters<typeof pickLanInterface>[0] = networkInterfaces(),
): (remote: string | undefined) => boolean {
  const own: Parameters<typeof pickLanInterface>[0] = {};
  for (const [name, infos] of Object.entries(interfaces)) {
    own[name] = infos?.filter((i) => i.address === host);
  }
  const iface = pickLanInterface(own);
  return (remote) => {
    if (!remote) return false;
    if (isLoopback(remote)) return true;
    return iface ? isSameSubnet(remote, iface) : false;
  };
}

/** Whether a WebSocket Origin header may connect. A missing header is allowed. */
export function originAllowed(origin: string | undefined, host: string | undefined): boolean {
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpFailure('bad_request', 'body exceeds 20 MB');
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpFailure('bad_request', 'body is not valid JSON');
  }
}

export function createWebServer(opts: WebServerOptions): WebServer {
  const { hub } = opts;
  const now = opts.now ?? Date.now;
  const idleOffMs = opts.idleOffMs ?? DEFAULT_IDLE_OFF_MS;
  const pairing = new PairingStore({ devicesFile: opts.devicesFile, now });
  const staticRoot = resolve(opts.staticDir);
  const listeners = new Set<(s: WebServerState) => void>();
  const allow = opts.allowRemote ?? defaultAllow(opts.host);

  let server: http.Server | undefined;
  let wss: WebSocketServer | undefined;
  let boundPort = opts.port;
  let idleTimer: NodeJS.Timeout | undefined;
  let nextClient = 1;
  const sockets = new Set<net.Socket>();
  /** Open WebSockets by paired device id. */
  const wsByDevice = new Map<string, Set<WebSocket>>();
  let wsCount = 0;
  let refused: string | undefined;

  function state(): WebServerState {
    return { running: server !== undefined, devices: pairing.list(), ...(refused ? { refused } : {}) };
  }
  function emit(): void {
    const s = state();
    for (const fn of listeners) fn(s);
  }

  // ── Idle shutdown ───────────────────────────────────────────────────────

  function armIdle(): void {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = undefined;
    if (!server || wsCount > 0) return;
    idleTimer = setTimeout(() => void stop(), idleOffMs);
    idleTimer.unref();
  }

  // ── Responses ───────────────────────────────────────────────────────────

  function send(
    res: http.ServerResponse,
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
      'Cache-Control': 'no-store',
      ...headers,
    });
    res.end(payload);
  }

  async function serveStatic(pathname: string, res: http.ServerResponse, headers: Record<string, string>) {
    let rel: string;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      throw new HttpFailure('bad_request', 'malformed path');
    }
    if (rel.includes('\0')) throw new HttpFailure('bad_request', 'malformed path');
    let file = resolve(join(staticRoot, rel));
    if (file !== staticRoot && !file.startsWith(staticRoot + sep)) {
      throw new HttpFailure('not_found', 'not found');
    }
    try {
      if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
      const info = await stat(file);
      res.writeHead(200, {
        'Content-Type': CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
        'Content-Length': info.size,
        'Cache-Control': 'no-cache',
        ...headers,
      });
      createReadStream(file).pipe(res);
    } catch {
      throw new HttpFailure('not_found', 'not found');
    }
  }

  // ── Routes ──────────────────────────────────────────────────────────────

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://companion');
    const headers = securityHeaders(req.headers.host);
    const method = req.method ?? 'GET';

    if (url.pathname === '/pair' && method === 'GET') {
      const token = url.searchParams.get('token');
      const paired = token ? pairing.redeem(token, req.headers['user-agent']) : undefined;
      if (!paired) throw new HttpFailure('unauthorized', 'pairing link is invalid, used or expired');
      res.writeHead(302, { Location: '/', 'Set-Cookie': paired.cookie, 'Cache-Control': 'no-store', ...headers });
      res.end();
      return;
    }

    if (!pairing.verify(req.headers.cookie)) {
      throw new HttpFailure('unauthorized', 'pair this device first');
    }
    armIdle();

    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] === 'api') {
      let name: string | undefined;
      try {
        name = parts[2] === undefined ? undefined : decodeURIComponent(parts[2]);
      } catch {
        throw new HttpFailure('bad_request', 'malformed board name');
      }
      if (parts[1] === 'boards' && parts.length === 2 && method === 'GET') {
        return send(res, 200, { boards: hub.boards(), ...(opts.current ? { current: opts.current() } : {}) }, headers);
      }
      if (parts[1] === 'boards' && parts.length === 3 && method === 'GET') {
        if (!hub.has(name!)) throw new HttpFailure('not_found', `no board ${name}`);
        return send(res, 200, { board: name, elements: hub.snapshot(name!) }, headers);
      }
      if (parts[1] === 'send' && parts.length === 2 && method === 'POST') {
        const input = parseSend(await readBody(req));
        let delivery: Delivery;
        try {
          delivery = await opts.deliver(input);
        } catch (err) {
          throw new HttpFailure('conflict', err instanceof Error ? err.message : String(err));
        }
        const to = opts.describeSession?.(delivery.sessionId);
        return send(
          res,
          200,
          { ok: true, id: delivery.id, sessionId: delivery.sessionId, ...(to ? { to } : {}) },
          headers,
        );
      }
      throw new HttpFailure('not_found', 'no such route');
    }

    if (method !== 'GET' && method !== 'HEAD') throw new HttpFailure('not_found', 'no such route');
    await serveStatic(url.pathname, res, headers);
  }

  function onRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    handle(req, res).catch((err: unknown) => {
      if (res.headersSent) return void res.destroy();
      const code = err instanceof HttpFailure ? err.code : 'internal';
      const error = err instanceof Error ? err.message : String(err);
      send(res, STATUS[code], { error, code } satisfies WebError, securityHeaders(req.headers.host));
    });
  }

  // ── WebSocket ───────────────────────────────────────────────────────────

  function onUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    const reject = (status: string) => {
      socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };
    const url = new URL(req.url ?? '/', 'http://companion');
    if (url.pathname !== '/ws') return reject('404 Not Found');
    const device = pairing.verify(req.headers.cookie);
    if (!device) return reject('401 Unauthorized');
    if (!originAllowed(req.headers.origin, req.headers.host)) return reject('403 Forbidden');

    const board = url.searchParams.get('board') || 'current';
    wss!.handleUpgrade(req, socket, head, (ws) => attachSocket(ws, device.id, board));
  }

  function attachSocket(ws: WebSocket, deviceId: string, board: string): void {
    const set = wsByDevice.get(deviceId) ?? new Set();
    wsByDevice.set(deviceId, set);
    set.add(ws);
    wsCount += 1;
    armIdle();

    const client: HubClient = {
      id: `web-${nextClient++}`,
      send: (message) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
      },
    };
    const leave = hub.join(board, client);

    ws.on('message', (data) => {
      if (!pairing.has(deviceId)) return ws.close(4001, 'revoked');
      try {
        const msg: unknown = JSON.parse(String(data));
        const elements = (msg as { type?: unknown; elements?: unknown })?.elements;
        if ((msg as { type?: unknown })?.type !== 'update' || !Array.isArray(elements)) return;
        hub.apply(board, client.id, elements.filter(isSyncElement) as SyncElement[]);
      } catch {
        // Malformed frames are ignored.
      }
    });
    ws.on('close', () => {
      leave();
      set.delete(ws);
      if (set.size === 0) wsByDevice.delete(deviceId);
      wsCount -= 1;
      armIdle();
    });
    ws.on('error', () => ws.terminate());
  }

  pairing.onChange(() => {
    for (const [deviceId, set] of wsByDevice) {
      if (pairing.has(deviceId)) continue;
      for (const ws of set) ws.close(4001, 'revoked');
    }
    emit();
  });

  // ── Lifecycle ───────────────────────────────────────────────────────────

  async function start(): Promise<{ host: string; port: number }> {
    if (server) return { host: opts.host, port: boundPort };
    if (!isLoopback(opts.host) && !isPrivateIpv4(opts.host)) {
      throw new Error(`refusing to bind ${opts.host}: use a private LAN or loopback address`);
    }
    const s = http.createServer(onRequest);
    s.on('connection', (socket) => {
      const remote = socket.remoteAddress;
      if (!guardConnection(socket, allow)) {
        const address = remote ? stripMapped(remote) : 'an unknown address';
        if (address !== refused) {
          refused = address;
          emit();
        }
        return;
      }
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    s.on('upgrade', onUpgrade);
    wss = new WebSocketServer({ noServer: true, maxPayload: MAX_BODY_BYTES });
    await new Promise<void>((resolveListen, reject) => {
      s.once('error', reject);
      s.listen(opts.port, opts.host, () => {
        s.off('error', reject);
        resolveListen();
      });
    });
    server = s;
    boundPort = (s.address() as net.AddressInfo).port;
    armIdle();
    emit();
    return { host: opts.host, port: boundPort };
  }

  async function stop(): Promise<void> {
    const s = server;
    if (!s) return;
    server = undefined;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = undefined;
    for (const set of wsByDevice.values()) for (const ws of set) ws.terminate();
    wss?.close();
    wss = undefined;
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolveClose) => s.close(() => resolveClose()));
    emit();
  }

  return {
    start,
    stop,
    async newPairingUrl() {
      const host = opts.host.includes(':') ? `[${opts.host}]` : opts.host;
      const url = `http://${host}:${boundPort}/pair?token=${pairing.newToken()}`;
      const qrSvg = await QRCode.toString(url, { type: 'svg', margin: 1 });
      return { url, qrSvg };
    },
    devices: () => pairing.list(),
    revoke: (id) => pairing.revoke(id),
    allows: (remote) => allow(remote),
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

function parseSend(body: unknown): DeliveryInput {
  const o = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  if (typeof o.board !== 'string' || !o.board) throw new HttpFailure('bad_request', 'board is required');
  if (typeof o.png !== 'string' || !o.png) throw new HttpFailure('bad_request', 'png must be base64');
  if (typeof o.scene !== 'object' || o.scene === null) {
    throw new HttpFailure('bad_request', 'scene must be an object');
  }
  if (o.notes !== undefined && typeof o.notes !== 'string') {
    throw new HttpFailure('bad_request', 'notes must be a string');
  }
  const png = Buffer.from(o.png.replace(/^data:image\/png;base64,/, ''), 'base64');
  if (png.length === 0) throw new HttpFailure('bad_request', 'png must be base64');
  return { png, scene: o.scene, boardName: o.board, ...(o.notes ? { notes: o.notes } : {}) };
}

