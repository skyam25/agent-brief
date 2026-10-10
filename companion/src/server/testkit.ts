/** Test helpers: a socket client, a fake backend and a temp-dir harness. */

import { mkdtempSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import type { BoardBackend } from './contract';
import { createCompanionServer } from './index';

export interface Reply<T = any> {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: T;
  raw: Buffer;
}

export function request(
  socketPath: string,
  method: string,
  path: string,
  body?: unknown,
  rawBody?: string,
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = rawBody ?? (body === undefined ? undefined : JSON.stringify(body));
    const req = http.request(
      {
        socketPath,
        method,
        path,
        agent: false,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks);
          const isJson = String(res.headers['content-type']).includes('json');
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: isJson && raw.length ? JSON.parse(raw.toString('utf8')) : raw,
            raw,
          });
        });
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

export function fakeBackend() {
  const backend = {
    health: vi.fn(() => ({ panelVisible: true, currentBoard: 'main' })),
    open: vi.fn(async (req: { board?: string }) => ({ board: req.board ?? 'main' })),
    listBoards: vi.fn(async () => ({ boards: [], current: 'main' })),
    read: vi.fn(async (board: string) => ({
      board,
      elements: [],
      bounds: { x: 0, y: 0, width: 0, height: 0 },
    })),
    png: vi.fn(async () => Buffer.from([0x89, 0x50, 0x4e, 0x47])),
    draw: vi.fn(async () => ({ ids: ['a'], batchId: 'b1' })),
    update: vi.fn(async () => ({ ids: ['a'], batchId: 'b2' })),
    remove: vi.fn(async () => ({ ids: ['a'], batchId: 'b3' })),
  };
  return backend satisfies BoardBackend;
}

export function tempDir(prefix = 'cs'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** A server on a short temp socket with a controllable clock. */
export function harness() {
  const dir = tempDir();
  const socketPath = join(dir, 's.sock');
  const backend = fakeBackend();
  const clock = { t: 1_000_000 };
  const server = createCompanionServer({ socketPath, backend, now: () => clock.t });
  const call = (method: string, path: string, body?: unknown) =>
    request(socketPath, method, path, body);
  return { dir, socketPath, backend, clock, server, call };
}
