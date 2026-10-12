/** CLI test setup: a fake app on a temp socket, fresh for each test. */

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach } from 'vitest';
import type { ErrorBody } from '../src/protocol';
import { main } from './main';

/** A PNG header, which is all the CLI reads to size an image. */
export function pngHeader(width: number, height: number): Buffer {
  const b = Buffer.alloc(33);
  b.writeUInt32BE(0x89504e47, 0);
  b.writeUInt32BE(0x0d0a1a0a, 4);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

export interface Seen {
  method: string;
  url: string;
  body: unknown;
}

export type Handler = (req: Seen) => { status?: number; json?: unknown; raw?: Buffer; type?: string };

export interface FakeApp {
  dir: string;
  socket: string;
  server: http.Server;
  seen: Seen[];
  handler: Handler;
}

export const fail = (code: ErrorBody['code'], error: string, status = 400): Handler => () => ({
  status,
  json: { code, error } satisfies ErrorBody,
});

/** Starts a fake app before each test and closes it after. Tests set `app.handler` to shape replies. */
export function useFakeApp() {
  const app = {} as FakeApp;

  beforeEach(async () => {
    app.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmp-'));
    app.socket = path.join(app.dir, 's.sock');
    app.seen = [];
    app.handler = () => ({ json: {} });
    app.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        const entry: Seen = { method: req.method!, url: req.url!, body: text ? JSON.parse(text) : undefined };
        app.seen.push(entry);
        const r = app.handler(entry);
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
    await new Promise<void>((ok) => app.server.listen(app.socket, ok));
  });

  afterEach(async () => {
    await new Promise((ok) => app.server.close(ok));
    fs.rmSync(app.dir, { recursive: true, force: true });
  });

  async function run(argv: string[], stdin = '') {
    let stdout = '';
    let stderr = '';
    const code = await main(argv, {
      stdin: async () => stdin,
      stdout: (s) => (stdout += s),
      stderr: (s) => (stderr += s),
      env: { COMPANION_SOCKET: app.socket },
      cwd: app.dir,
      now: () => new Date('2026-10-10T15:30:00Z'),
    });
    return { code, stdout, stderr };
  }

  return { app, run };
}
