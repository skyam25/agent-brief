/** Socket server for the Agent Brief app. See contract.ts for the seam to the app. */

import { chmod, mkdir, unlink } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { dirname, join } from 'node:path';
import {
  outputsFile,
  PROTOCOL_VERSION,
  type DeliveriesResponse,
  type Delivery,
  type ErrorBody,
  type Health,
  type OpenRequest,
  type SessionInfo,
  type SessionsResponse,
} from '../protocol';
import { buildDraft, freeId, writeBundle } from './bundle';
import type { CompanionServer, CompanionServerOptions, DeliveryInput, InitiativeBackend } from './contract';
import {
  BadRequest,
  parseDelete,
  parseDraw,
  parseInitiativeCreate,
  parseInitiativeUpdate,
  parseLimit,
  parseMaxEdge,
  parseNote,
  parseOpen,
  parseRegion,
  parseSession,
  parseSessionInitiative,
  parseSessionPatch,
  parseUpdate,
} from './validate';

export type { CompanionServer, CompanionServerOptions, DeliveryInput, InitiativeBackend } from './contract';

const SESSION_TTL_MS = 90_000;
const SWEEP_INTERVAL_MS = 15_000;
const MAX_BODY_BYTES = 20 * 1024 * 1024;
const DEFAULT_WAIT_S = 25;
const MAX_WAIT_S = 30;

/** Where a tracked session keeps its items: `<cwd>/.feedback/items/<sessionId>.md`. */
export function itemsFile(cwd: string, sessionId: string): string {
  return join(cwd, '.feedback', 'items', `${sessionId}.md`);
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorBody['code'],
    message: string,
  ) {
    super(message);
  }
}

const notFound = (what = 'no such route') => new HttpError(404, 'not_found', what);

const STATUS_BY_CODE: Record<ErrorBody['code'], number> = {
  not_found: 404,
  bad_request: 400,
  conflict: 409,
  unavailable: 503,
  internal: 500,
};

/** Answers whether something accepts connections on the socket path. */
function isLive(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.connect(socketPath);
    probe.once('connect', () => {
      probe.destroy();
      resolve(true);
    });
    probe.once('error', () => resolve(false));
  });
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'bad_request', 'body exceeds 20 MB');
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new BadRequest('body is not valid JSON');
  }
}

export function createCompanionServer(opts: CompanionServerOptions): CompanionServer {
  const { socketPath, backend } = opts;
  const now = opts.now ?? Date.now;

  /** The app's initiative store, or 503. */
  function initiatives(): InitiativeBackend {
    if (!opts.initiatives) throw new HttpError(503, 'unavailable', 'this app keeps no initiatives');
    return opts.initiatives;
  }

  const sessionMap = new Map<string, SessionInfo>();
  const queues = new Map<string, Delivery[]>();
  const waiters = new Map<string, Set<() => void>>();
  const sessionListeners = new Set<(s: SessionsResponse) => void>();
  const openListeners = new Set<(req: OpenRequest) => void>();
  let target: string | undefined;
  /** The target that lapsed without ending. It comes back when that session registers again. */
  let held: string | undefined;
  let sweepTimer: NodeJS.Timeout | undefined;
  let closing = false;

  // ── Sessions ────────────────────────────────────────────────────────────

  /** A session with the tracking state, mode and outputs path the app keeps for it. */
  function withAppState(s: SessionInfo): SessionInfo {
    const t = backend.tracking?.(s.sessionId);
    const m = backend.mode?.(s.sessionId);
    return {
      ...s,
      outputsPath: outputsFile(s.cwd, s.sessionId),
      ...(t ? { trackItems: t.trackItems, ...(t.trackItems ? { itemsPath: itemsFile(s.cwd, s.sessionId) } : {}) } : {}),
      ...(m && m.mode !== 'default' ? { mode: m.mode, ...(m.mode === 'prototype' && m.fidelity ? { fidelity: m.fidelity } : {}) } : {}),
    };
  }

  function snapshot(): SessionsResponse {
    return {
      sessions: [...sessionMap.values()].map(withAppState),
      targetSessionId: target,
    };
  }

  /** A live session for the `/sessions/:id` routes, or 404. */
  function liveSession(id: string): SessionInfo {
    sweep();
    const s = sessionMap.get(id);
    if (!s) throw notFound(`no session ${id}`);
    return s;
  }

  function emitSessions(): void {
    const snap = snapshot();
    for (const fn of sessionListeners) fn(snap);
  }

  /** Drops expired sessions and clears a target that left. Returns true when anything changed. */
  function sweep(): boolean {
    const cutoff = now() - SESSION_TTL_MS;
    let changed = false;
    for (const [id, s] of sessionMap) {
      if ((s.lastSeen ?? 0) < cutoff) {
        sessionMap.delete(id);
        changed = true;
      }
    }
    if (target !== undefined && !sessionMap.has(target)) {
      held = target;
      target = undefined;
      changed = true;
    }
    if (changed) emitSessions();
    return changed;
  }

  function register(info: SessionInfo): void {
    sweep();
    const prev = sessionMap.get(info.sessionId);
    sessionMap.set(info.sessionId, { ...info, lastSeen: now() });
    const isBack = target === undefined && held === info.sessionId;
    if (isBack) {
      target = held;
      held = undefined;
    }
    const changed =
      isBack ||
      !prev ||
      prev.cwd !== info.cwd ||
      prev.title !== info.title ||
      prev.pid !== info.pid ||
      prev.summary !== info.summary ||
      prev.activeAt !== info.activeAt ||
      JSON.stringify(prev.host) !== JSON.stringify(info.host);
    if (changed) emitSessions();
  }

  function removeSession(id: string): boolean {
    sweep();
    if (held === id) held = undefined;
    if (!sessionMap.delete(id)) return false;
    if (target === id) target = undefined;
    emitSessions();
    return true;
  }

  function setTarget(id: string | undefined): void {
    sweep();
    if (id !== undefined && !sessionMap.has(id)) throw new Error(`unknown session ${id}`);
    held = undefined;
    if (target === id) return;
    target = id;
    emitSessions();
  }

  // ── Deliveries ──────────────────────────────────────────────────────────

  function wake(sessionId: string): void {
    const set = waiters.get(sessionId);
    if (!set) return;
    for (const release of [...set]) release();
  }

  function pending(sessionId: string): Delivery[] {
    return [...(queues.get(sessionId) ?? [])];
  }

  function poll(sessionId: string, waitS: number, req: http.IncomingMessage): Promise<Delivery[]> {
    sweep();
    const touch = () => {
      const s = sessionMap.get(sessionId);
      if (s) s.lastSeen = now();
    };
    touch();
    const ready = pending(sessionId);
    if (ready.length > 0 || waitS === 0 || closing) return Promise.resolve(ready);

    return new Promise((resolve) => {
      const set = waiters.get(sessionId) ?? new Set();
      waiters.set(sessionId, set);
      const finish = () => {
        clearTimeout(timer);
        set.delete(finish);
        req.socket.off('close', finish);
        touch();
        resolve(pending(sessionId));
      };
      const timer = setTimeout(finish, waitS * 1000);
      set.add(finish);
      req.socket.once('close', finish);
    });
  }

  function ack(deliveryId: string): boolean {
    for (const [sessionId, queue] of queues) {
      const i = queue.findIndex((d) => d.id === deliveryId);
      if (i === -1) continue;
      queue.splice(i, 1);
      if (queue.length === 0) queues.delete(sessionId);
      return true;
    }
    return false;
  }

  async function deliver(input: DeliveryInput): Promise<Delivery> {
    sweep();
    const sessionId = input.sessionId ?? target;
    if (sessionId === undefined) throw new Error('no Claude Code session to deliver to');
    const session = sessionMap.get(sessionId);
    if (!session) throw new Error(`unknown session ${sessionId}`);

    const sketches = join(session.cwd, '.feedback', 'sketches');
    const id = freeId(sketches, now());
    const dir = join(sketches, id);
    await writeBundle(dir, input);

    const delivery: Delivery = {
      id,
      sessionId,
      dir,
      draft: buildDraft(id, input),
      mode: input.mode ?? 'fill',
      createdAt: now(),
    };
    const queue = queues.get(sessionId) ?? [];
    queue.push(delivery);
    queues.set(sessionId, queue);
    wake(sessionId);
    return delivery;
  }

  // ── Routing ─────────────────────────────────────────────────────────────

  type Reply = { status?: number; json?: unknown; png?: Buffer };

  async function route(req: http.IncomingMessage): Promise<Reply> {
    const url = new URL(req.url ?? '/', 'http://companion');
    const method = req.method ?? 'GET';
    let parts: string[];
    try {
      parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    } catch {
      throw new BadRequest('malformed percent-encoding in path');
    }
    const q = url.searchParams;
    const [root, id, sub] = parts;

    if (root === 'health' && parts.length === 1 && method === 'GET') {
      const health: Health = {
        ok: true,
        version: PROTOCOL_VERSION,
        pid: process.pid,
        ...backend.health(),
      };
      return { json: health };
    }

    if (root === 'sessions') {
      if (parts.length === 1 && method === 'POST') {
        register(parseSession(await readJson(req)));
        return { json: snapshot() };
      }
      if (parts.length === 1 && method === 'GET') {
        sweep();
        return { json: snapshot() };
      }
      if (parts.length === 2 && method === 'DELETE') {
        return { json: { removed: removeSession(id) } };
      }
      if (parts.length === 2 && method === 'GET') {
        return { json: withAppState(liveSession(id)) };
      }
      if (parts.length === 2 && method === 'PATCH') {
        const patch = parseSessionPatch(await readJson(req));
        const s = liveSession(id);
        if (patch.tracking && !backend.setTracking) throw new HttpError(503, 'unavailable', 'this app does not track items');
        if (patch.mode && !backend.setMode) throw new HttpError(503, 'unavailable', 'this app does not mirror modes');
        if (patch.tracking) await backend.setTracking!(id, patch.tracking.trackItems);
        if (patch.mode) await backend.setMode!(id, patch.mode);
        emitSessions();
        return { json: withAppState(s) };
      }
      // A binding outlives the session's registration, so reads and detaches take any id.
      if (parts.length === 3 && sub === 'initiative') {
        if (method === 'GET') {
          const snap = initiatives().snapshot(id);
          return snap ? { json: snap } : { status: 204 };
        }
        if (method === 'PUT') {
          const body = parseSessionInitiative(await readJson(req));
          liveSession(id);
          return { json: initiatives().attach(id, body.initiativeId) };
        }
        if (method === 'DELETE') return { json: { detached: initiatives().detach(id) } };
      }
    }

    if (root === 'initiatives') {
      const store = initiatives();
      if (parts.length === 1 && method === 'GET') return { json: store.list() };
      if (parts.length === 1 && method === 'POST') return { json: store.create(parseInitiativeCreate(await readJson(req))) };
      if (parts.length === 2 && id === 'recent' && method === 'GET') return { json: store.recent(parseLimit(q.get('limit'))) };
      if (parts.length === 2 && id === 'find' && method === 'GET') {
        const words = q.get('q')?.trim();
        if (!words) throw new BadRequest('q is required');
        return { json: store.find(words) };
      }
      if (parts.length === 2 && method === 'GET') return { json: store.get(id) };
      if (parts.length === 2 && method === 'PUT') return { json: store.update(id, parseInitiativeUpdate(await readJson(req))) };
      if (parts.length === 3 && sub === 'history' && method === 'GET') return { json: store.history(id) };
    }

    if (root === 'open' && parts.length === 1 && method === 'POST') {
      const body = parseOpen(await readJson(req));
      sweep();
      if (body.output && !sessionMap.has(body.sessionId!)) throw new BadRequest('body.sessionId names no live session');
      if (body.sessionId !== undefined && sessionMap.has(body.sessionId)) setTarget(body.sessionId);
      const res = await backend.open(body);
      for (const fn of openListeners) fn(body);
      const opened = body.output ? res.opened : (res.opened ?? (body.mode === 'write' ? 'note' : 'board'));
      return { json: { ...res, ...(opened ? { opened } : {}), targetSessionId: target } };
    }

    if (root === 'notes' && parts.length === 1 && method === 'POST') {
      const body = parseNote(await readJson(req));
      if (!backend.addNote) throw new HttpError(503, 'unavailable', 'this app does not take notes');
      if (body.sessionId !== undefined) liveSession(body.sessionId);
      return { json: await backend.addNote(body) };
    }

    if (root === 'deliveries') {
      if (parts.length === 1 && method === 'GET') {
        const session = q.get('session');
        if (!session) throw new BadRequest('session is required');
        const rawWait = q.get('wait');
        const wait = rawWait === null ? DEFAULT_WAIT_S : Number(rawWait);
        if (!Number.isFinite(wait)) throw new BadRequest('wait must be a number of seconds');
        const clamped = Math.min(MAX_WAIT_S, Math.max(0, wait));
        const deliveries = await poll(session, clamped, req);
        const body: DeliveriesResponse = { deliveries };
        return { json: body };
      }
      if (parts.length === 3 && sub === 'ack' && method === 'POST') {
        return { json: { acked: ack(id) } };
      }
    }

    if (root === 'boards') {
      if (parts.length === 1 && method === 'GET') return { json: await backend.listBoards() };
      if (id !== undefined && sub === 'elements' && parts.length === 3) {
        if (method === 'GET') {
          return { json: await backend.read(id, parseRegion(q.get('region'))) };
        }
        if (method === 'PATCH') {
          return { json: await backend.update(id, parseUpdate(await readJson(req))) };
        }
        if (method === 'DELETE') {
          return { json: await backend.remove(id, parseDelete(await readJson(req))) };
        }
      }
      if (id !== undefined && sub === 'png' && parts.length === 3 && method === 'GET') {
        const png = await backend.png(id, {
          region: parseRegion(q.get('region')),
          maxEdge: parseMaxEdge(q.get('maxEdge')),
        });
        return { png };
      }
      if (id !== undefined && sub === 'draw' && parts.length === 3 && method === 'POST') {
        return { json: await backend.draw(id, parseDraw(await readJson(req))) };
      }
    }

    throw notFound();
  }

  function errorReply(err: unknown): { status: number; body: ErrorBody } {
    if (err instanceof HttpError) {
      return { status: err.status, body: { error: err.message, code: err.code } };
    }
    if (err instanceof BadRequest) {
      return { status: 400, body: { error: err.message, code: 'bad_request' } };
    }
    const message = err instanceof Error ? err.message : String(err);
    const code = (err as { code?: unknown } | null)?.code;
    if (typeof code === 'string' && code in STATUS_BY_CODE) {
      const known = code as ErrorBody['code'];
      return { status: STATUS_BY_CODE[known], body: { error: message, code: known } };
    }
    return { status: 500, body: { error: message, code: 'internal' } };
  }

  const server = http.createServer(async (req, res) => {
    try {
      const reply = await route(req);
      if (reply.png) {
        res.writeHead(reply.status ?? 200, {
          'Content-Type': 'image/png',
          'Content-Length': reply.png.length,
        });
        res.end(reply.png);
        return;
      }
      if (reply.status === 204) {
        res.writeHead(204);
        res.end();
        return;
      }
      const payload = JSON.stringify(reply.json ?? {});
      res.writeHead(reply.status ?? 200, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      });
      res.end(payload);
    } catch (err) {
      if (res.headersSent || res.destroyed) {
        res.destroy();
        return;
      }
      const { status, body } = errorReply(err);
      const payload = JSON.stringify(body);
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...(status === 413 ? { Connection: 'close' } : {}),
      });
      res.end(payload);
    }
  });

  // ── Lifecycle ───────────────────────────────────────────────────────────

  async function listen(): Promise<void> {
    await mkdir(dirname(socketPath), { recursive: true });
    if (await isLive(socketPath)) {
      throw new Error(`another companion server is already listening on ${socketPath}`);
    }
    await unlink(socketPath).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT') throw err;
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => {
        server.off('error', reject);
        resolve();
      });
    });
    await chmod(socketPath, 0o600);
    closing = false;
    sweepTimer = setInterval(sweep, SWEEP_INTERVAL_MS);
    sweepTimer.unref();
  }

  async function close(): Promise<void> {
    closing = true;
    if (sweepTimer) clearInterval(sweepTimer);
    sweepTimer = undefined;
    for (const set of waiters.values()) for (const release of [...set]) release();
    if (!server.listening) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  return {
    listen,
    close,
    sessions() {
      sweep();
      return snapshot();
    },
    setTarget,
    deliver,
    refreshSessions: emitSessions,
    onSessionsChange(fn) {
      sessionListeners.add(fn);
      return () => sessionListeners.delete(fn);
    },
    onOpen(fn) {
      openListeners.add(fn);
      return () => openListeners.delete(fn);
    },
  };
}
