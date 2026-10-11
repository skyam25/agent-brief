/**
 * LAN web server for the iPad client. It binds to one private or loopback
 * address and drops connections from outside the subnet before reading a byte.
 * The client's static files are open to that subnet. The API and the WebSocket
 * need a paired device's credential, which the client keeps in localStorage and
 * sends as a bearer token or a WebSocket subprotocol. No cookies are used, so
 * other pages and other services on the Mac's address never receive it.
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
import {
  HTTP_RATE,
  MAX_BOARD_BYTES,
  MAX_MESSAGE_BYTES,
  MAX_SEND_BYTES,
  MAX_SMALL_BODY_BYTES,
  MAX_SOCKETS_PER_DEVICE,
  RateLimiter,
  SEND_RATE,
  WS_RATE,
} from './limits';
import { PairingStore, type DeviceInfo } from './pairing';
import { isSyncElement, type HubClient, type SyncElement, type SyncHub } from './sync-hub';

export const DEFAULT_PORT = 47613;
const DEFAULT_IDLE_OFF_MS = 8 * 3600_000;
/** The WebSocket subprotocol. A second one, `auth.<credential>`, carries the credential. */
export const WS_PROTOCOL = 'agent-brief';
const WS_AUTH_PREFIX = 'auth.';

/** The Claude Code session a Send from the iPad goes to. */
export interface Destination {
  sessionId: string;
  label: string;
}

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
  /** The session the Mac sends to now, if one is chosen. */
  destination: () => Destination | undefined;
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
  /** Tells connected clients where Send goes now. */
  destinationChanged(): void;
  /** Whether a remote address may connect. The same check runs on every new socket. */
  allows(remote: string | undefined): boolean;
  /** Fires when the server starts or stops and when the device list changes. */
  onChange(fn: (state: WebServerState) => void): () => void;
}

interface WebError {
  error: string;
  code: 'unauthorized' | 'forbidden' | 'not_found' | 'bad_request' | 'conflict' | 'too_many' | 'internal';
}

const STATUS: Record<WebError['code'], number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  bad_request: 400,
  conflict: 409,
  too_many: 429,
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
  constructor(
    readonly code: WebError['code'],
    message: string,
    /** Extra fields for the error body. */
    readonly extra: Record<string, unknown> = {},
  ) {
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

/** The credential in an `Authorization: Bearer` header. */
export function bearerCredential(header: string | undefined): string | undefined {
  const match = /^Bearer ([\w.-]+)$/.exec(header ?? '');
  return match?.[1];
}

/** The credential in a `Sec-WebSocket-Protocol` header, when the client also offers ours. */
export function protocolCredential(header: string | undefined): string | undefined {
  const offered = (header ?? '').split(',').map((p) => p.trim());
  if (!offered.includes(WS_PROTOCOL)) return undefined;
  return offered.find((p) => p.startsWith(WS_AUTH_PREFIX))?.slice(WS_AUTH_PREFIX.length) || undefined;
}

async function readBody(req: http.IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpFailure('bad_request', `body exceeds ${Math.round(limit / 1024)} KB`);
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
  const httpLimit = new RateLimiter(HTTP_RATE, now);
  const wsLimit = new RateLimiter(WS_RATE, now);
  const sendLimit = new RateLimiter(SEND_RATE, now);

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
  const authority = () => `${opts.host.includes(':') ? `[${opts.host}]` : opts.host}:${boundPort}`;

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
    if (req.headers.host !== authority()) throw new HttpFailure('forbidden', 'unexpected host');
    const url = new URL(req.url ?? '/', 'http://companion');
    const headers = securityHeaders(authority());
    const method = req.method ?? 'GET';
    if (!httpLimit.take(`address:${stripMapped(req.socket.remoteAddress ?? '')}`)) {
      throw new HttpFailure('too_many', 'too many requests');
    }

    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] !== 'api') {
      if (method !== 'GET' && method !== 'HEAD') throw new HttpFailure('not_found', 'no such route');
      return serveStatic(url.pathname, res, headers);
    }

    if (parts[1] === 'pair' && parts.length === 2 && method === 'POST') {
      const body = (await readBody(req, MAX_SMALL_BODY_BYTES)) as { token?: unknown } | null;
      const token = typeof body?.token === 'string' ? body.token : undefined;
      const paired = token ? pairing.redeem(token, req.headers['user-agent']) : undefined;
      if (!paired) throw new HttpFailure('unauthorized', 'pairing code is invalid, used or expired');
      return send(res, 200, { credential: paired.credential }, headers);
    }

    const device = pairing.verify(bearerCredential(req.headers.authorization));
    if (!device) throw new HttpFailure('unauthorized', 'pair this device first');
    if (!httpLimit.take(`device:${device.id}`)) throw new HttpFailure('too_many', 'too many requests');
    armIdle();

    let name: string | undefined;
    try {
      name = parts[2] === undefined ? undefined : decodeURIComponent(parts[2]);
    } catch {
      throw new HttpFailure('bad_request', 'malformed board name');
    }
    if (parts[1] === 'boards' && parts.length === 2 && method === 'GET') {
      return send(
        res,
        200,
        { boards: hub.boards(), ...(opts.current ? { current: opts.current() } : {}), destination: opts.destination() ?? null },
        headers,
      );
    }
    if (parts[1] === 'boards' && parts.length === 3 && method === 'GET') {
      if (!hub.has(name!)) throw new HttpFailure('not_found', `no board ${name}`);
      return send(res, 200, { board: name, elements: hub.snapshot(name!) }, headers);
    }
    if (parts[1] === 'send' && parts.length === 2 && method === 'POST') {
      if (!sendLimit.take(device.id)) throw new HttpFailure('too_many', 'Too many sends. Wait a few seconds.');
      const input = parseSend(await readBody(req, MAX_SEND_BYTES));
      // Send goes only where the iPad showed it would. A changed choice on the Mac is refused.
      const destination = opts.destination();
      if (!destination) {
        throw new HttpFailure('conflict', 'Choose a Claude Code session on the Mac first.', { destination: null });
      }
      if (input.sessionId !== destination.sessionId) {
        throw new HttpFailure('conflict', `The Mac now sends to ${destination.label}. Send again to send there.`, {
          destination,
        });
      }
      let delivery: Delivery;
      try {
        delivery = await opts.deliver(input);
      } catch (err) {
        throw new HttpFailure('conflict', err instanceof Error ? err.message : String(err));
      }
      return send(res, 200, { ok: true, id: delivery.id, sessionId: delivery.sessionId, to: destination.label }, headers);
    }
    throw new HttpFailure('not_found', 'no such route');
  }

  function onRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    handle(req, res).catch((err: unknown) => {
      if (res.headersSent) return void res.destroy();
      const code = err instanceof HttpFailure ? err.code : 'internal';
      const error = err instanceof Error ? err.message : String(err);
      const extra = err instanceof HttpFailure ? err.extra : {};
      send(res, STATUS[code], { ...extra, error, code } satisfies WebError, securityHeaders(authority()));
    });
  }

  // ── WebSocket ───────────────────────────────────────────────────────────

  function onUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    const reject = (status: string) => {
      socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };
    if (req.headers.host !== authority()) return reject('403 Forbidden');
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://companion');
    } catch {
      return reject('400 Bad Request');
    }
    if (url.pathname !== '/ws') return reject('404 Not Found');
    const device = pairing.verify(protocolCredential(req.headers['sec-websocket-protocol']));
    if (!device) return reject('401 Unauthorized');
    if ((wsByDevice.get(device.id)?.size ?? 0) >= MAX_SOCKETS_PER_DEVICE) return reject('429 Too Many Requests');

    const board = url.searchParams.get('board') || 'current';
    // Only boards seeded by the Mac may be edited. Arbitrary names otherwise
    // reach the disk persistence callback and can throw outside the request.
    if (!hub.has(board)) return reject('404 Not Found');
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
    sendDestination(ws);

    ws.on('message', (data) => {
      if (!pairing.touch(deviceId)) return ws.close(4001, 'revoked');
      if (!wsLimit.take(deviceId)) return ws.close(4008, 'too many messages');
      try {
        const msg: unknown = JSON.parse(String(data));
        const elements = (msg as { type?: unknown; elements?: unknown })?.elements;
        if ((msg as { type?: unknown })?.type !== 'update' || !Array.isArray(elements)) return;
        const valid = elements.filter(isSyncElement) as SyncElement[];
        if (!hub.fits(board, valid, MAX_BOARD_BYTES)) {
          ws.send(JSON.stringify({ type: 'notice', board, text: 'This board is full. Clear some of it on the Mac.' }));
          return;
        }
        hub.apply(board, client.id, valid);
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

  function sendDestination(ws: WebSocket): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'destination', destination: opts.destination() ?? null }));
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
    wss = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_MESSAGE_BYTES,
      // Answers with our protocol only, so the credential is never echoed back.
      handleProtocols: (offered) => (offered.has(WS_PROTOCOL) ? WS_PROTOCOL : false),
    });
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
      // The code rides in the fragment, so it never reaches a request line or a log.
      const url = `http://${host}:${boundPort}/#pair=${pairing.newToken()}`;
      const qrSvg = await QRCode.toString(url, { type: 'svg', margin: 1 });
      return { url, qrSvg };
    },
    devices: () => pairing.list(),
    revoke: (id) => pairing.revoke(id),
    destinationChanged() {
      for (const set of wsByDevice.values()) for (const ws of set) sendDestination(ws);
    },
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
  if (o.sessionId !== undefined && typeof o.sessionId !== 'string') {
    throw new HttpFailure('bad_request', 'sessionId must be a string');
  }
  const png = Buffer.from(o.png.replace(/^data:image\/png;base64,/, ''), 'base64');
  if (png.length === 0) throw new HttpFailure('bad_request', 'png must be base64');
  return {
    png,
    scene: o.scene,
    boardName: o.board,
    ...(o.sessionId ? { sessionId: o.sessionId } : {}),
    ...(o.notes ? { notes: o.notes } : {}),
  };
}

