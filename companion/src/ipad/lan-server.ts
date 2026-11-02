/** The iPad's API over TLS on the local network. See shared/ipad.ts. It exposes nothing from the socket protocol. */

import https from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { networkInterfaces } from 'node:os';
import type { ErrorBody } from '../protocol';
import type { StrokeEvent } from '../voice/types';
import { IPAD_MAX_BODY_BYTES, type IpadDelivery, type IpadDeliveryResult, type LanHandoffDetail, type LanHandoffsResponse, type PairResponse } from '../shared/ipad';
import type { LanCert } from './cert';
import { isLocalPeer, stripMapped, type Interfaces } from './lan';
import { DELIVER_RATE, MAX_SMALL_BODY_BYTES, PAIR_RATE, RateLimiter, REQUEST_RATE } from './limits';

export interface LanBackend {
  /** Undefined for a credential that matches no device. */
  verify(credential: string | undefined): { id: string } | undefined;
  /** Undefined for a used or expired code. */
  pair(code: string, deviceName: string, installId?: string): PairResponse | undefined;
  handoffs(): LanHandoffsResponse;
  /** Throws a `not_found` error for an unknown hand-off. */
  detail(id: string): LanHandoffDetail;
  deliver(id: string, deviceId: string, delivery: IpadDelivery): Promise<IpadDeliveryResult>;
  /** Removes this iPad from the Mac. */
  unpair(deviceId: string): void;
}

export interface LanServerOptions {
  cert: Pick<LanCert, 'key' | 'cert'>;
  backend: LanBackend;
  /** Binds IPv4 only, so the subnet check covers every peer. */
  host: string;
  port: number;
  interfaces?: () => Interfaces;
  onRefused?: (address: string) => void;
  now?: () => number;
}

export interface LanServer {
  listen(): Promise<number>;
  close(): Promise<void>;
}

class LanError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorBody['code'],
    message: string,
  ) {
    super(message);
  }
}

const MAX_INSTALL_ID = 128;

const STATUS: Record<ErrorBody['code'], number> = { not_found: 404, bad_request: 400, conflict: 409, unavailable: 503, internal: 500 };

const bad = (message: string) => new LanError(400, 'bad_request', message);

async function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new LanError(413, 'bad_request', `body exceeds ${limit} bytes`);
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw bad('body is not valid JSON');
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

const isBox = (v: unknown): v is StrokeEvent['bbox'] =>
  isRecord(v) && isNum(v.x) && isNum(v.y) && isNum(v.width) && isNum(v.height);

function isStroke(v: unknown): v is StrokeEvent {
  return (
    isRecord(v) &&
    isNum(v.t) &&
    isNum(v.tEnd) &&
    typeof v.elementId === 'string' &&
    typeof v.type === 'string' &&
    isBox(v.bbox) &&
    (v.by === 'user' || v.by === 'claude') &&
    (v.kind === 'add' || v.kind === 'erase' || v.kind === 'move')
  );
}

/** Checks a delivery body. Timeline code trusts these shapes. */
export function parseIpadDelivery(raw: unknown): IpadDelivery {
  if (!isRecord(raw)) throw bad('body must be an object');
  const { pngBase64, scene, notes, strokes, utterances, bounds } = raw;
  if (typeof pngBase64 !== 'string' || !pngBase64.startsWith('iVBOR')) throw bad('pngBase64 must be a base64 PNG');
  if (!isRecord(scene) || !Array.isArray(scene.elements)) throw bad('scene must be an Excalidraw scene');
  if (notes !== undefined && typeof notes !== 'string') throw bad('notes must be a string');
  if (!Array.isArray(strokes) || !strokes.every(isStroke)) throw bad('strokes must be stroke events');
  if (!Array.isArray(utterances) || !utterances.every((u) => isRecord(u) && isNum(u.t) && isNum(u.tEnd) && typeof u.text === 'string')) {
    throw bad('utterances must have t, tEnd and text');
  }
  if (!isBox(bounds)) throw bad('bounds must have x, y, width and height');
  return { pngBase64, scene, ...(notes !== undefined ? { notes } : {}), strokes, utterances: utterances as IpadDelivery['utterances'], bounds };
}

function bearer(req: IncomingMessage): string | undefined {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
  return m?.[1];
}

export function createLanServer(opts: LanServerOptions): LanServer {
  const { backend } = opts;
  const interfaces = opts.interfaces ?? networkInterfaces;
  const requests = new RateLimiter(REQUEST_RATE, opts.now);
  const pairs = new RateLimiter(PAIR_RATE, opts.now);
  const deliveries = new RateLimiter(DELIVER_RATE, opts.now);

  const limited = () => new LanError(429, 'unavailable', 'too many requests');

  async function route(req: IncomingMessage): Promise<unknown> {
    const parts = new URL(req.url ?? '/', 'https://mac').pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const [version, root, id, verb] = parts;
    if (version !== 'v1') throw new LanError(404, 'not_found', 'no such route');
    const method = req.method;
    const address = stripMapped(req.socket.remoteAddress ?? '');

    if (root === 'pair' && parts.length === 2 && method === 'POST') {
      if (!pairs.take(address)) throw limited();
      const body = await readJson(req, MAX_SMALL_BODY_BYTES);
      if (!isRecord(body) || typeof body.code !== 'string') throw bad('body.code is required');
      const installId = typeof body.installId === 'string' && body.installId ? body.installId.slice(0, MAX_INSTALL_ID) : undefined;
      const paired = backend.pair(body.code, typeof body.deviceName === 'string' ? body.deviceName : '', installId);
      if (!paired) throw new LanError(401, 'bad_request', 'This pairing code is used or expired. On the Mac, choose Pair iPad… and scan the new code.');
      return paired;
    }

    if (!requests.take(address)) throw limited();
    const device = backend.verify(bearer(req));
    if (!device) throw new LanError(401, 'bad_request', 'This iPad is not paired with the Mac. On the Mac, choose Pair iPad… and scan the code.');
    if (!requests.take(device.id)) throw limited();

    if (root === 'unpair' && parts.length === 2 && method === 'POST') {
      backend.unpair(device.id);
      return { ok: true };
    }
    if (root === 'handoffs' && parts.length === 2 && method === 'GET') return backend.handoffs();
    if (root === 'handoffs' && parts.length === 3 && method === 'GET') return backend.detail(id);
    if (root === 'handoffs' && parts.length === 4 && verb === 'deliver' && method === 'POST') {
      if (!deliveries.take(device.id)) throw limited();
      return backend.deliver(id, device.id, parseIpadDelivery(await readJson(req, IPAD_MAX_BODY_BYTES)));
    }
    throw new LanError(404, 'not_found', 'no such route');
  }

  function reply(res: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
      ...(status === 413 ? { Connection: 'close' } : {}),
    });
    res.end(payload);
  }

  function errorReply(err: unknown): { status: number; body: ErrorBody } {
    if (err instanceof LanError) return { status: err.status, body: { error: err.message, code: err.code } };
    const code = (err as { code?: unknown } | null)?.code;
    const message = err instanceof Error ? err.message : String(err);
    if (typeof code === 'string' && code in STATUS) return { status: STATUS[code as ErrorBody['code']], body: { error: message, code: code as ErrorBody['code'] } };
    return { status: 500, body: { error: message, code: 'internal' } };
  }

  const server = https.createServer({ key: opts.cert.key, cert: opts.cert.cert, minVersion: 'TLSv1.2' }, async (req, res) => {
    try {
      reply(res, 200, await route(req));
    } catch (err) {
      if (res.headersSent || res.destroyed) return void res.destroy();
      const { status, body } = errorReply(err);
      reply(res, status, body);
    }
  });

  // Peers outside this Mac's subnets never reach TLS.
  server.on('connection', (socket) => {
    if (isLocalPeer(socket.remoteAddress, interfaces())) return;
    opts.onRefused?.(stripMapped(socket.remoteAddress ?? 'unknown'));
    socket.destroy();
  });

  return {
    listen: () =>
      new Promise<number>((resolve, reject) => {
        server.once('error', reject);
        server.listen(opts.port, opts.host, () => {
          server.off('error', reject);
          resolve((server.address() as AddressInfo).port);
        });
      }),
    close: () =>
      new Promise<void>((resolve) => {
        if (!server.listening) return resolve();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
