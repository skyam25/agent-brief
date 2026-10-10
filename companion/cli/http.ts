import http from 'node:http';
import type { ErrorBody } from '../src/protocol';

/** The app is not listening on the socket. */
export class NotRunningError extends Error {}

/** The app answered with a non-2xx status. */
export class ApiError extends Error {
  constructor(
    readonly code: ErrorBody['code'] | 'internal',
    message: string,
  ) {
    super(message);
  }
}

export interface Reply {
  status: number;
  type: string;
  body: Buffer;
}

const NOT_RUNNING_CODES = new Set(['ENOENT', 'ECONNREFUSED', 'ENOTSOCK']);
const TIMEOUT_MS = 30_000;

export function send(
  socketPath: string,
  method: string,
  path: string,
  json?: unknown,
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = json === undefined ? undefined : Buffer.from(JSON.stringify(json));
    const req = http.request(
      {
        socketPath,
        method,
        path,
        headers: payload
          ? { 'content-type': 'application/json', 'content-length': payload.length }
          : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            type: String(res.headers['content-type'] ?? ''),
            body: Buffer.concat(chunks),
          }),
        );
        res.on('error', reject);
      },
    );
    req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error('request timed out')));
    req.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code && NOT_RUNNING_CODES.has(err.code)) reject(new NotRunningError());
      else reject(err);
    });
    if (payload) req.write(payload);
    req.end();
  });
}

/** Sends a request and returns the success reply, or throws ApiError. */
export async function call(
  socketPath: string,
  method: string,
  path: string,
  json?: unknown,
): Promise<Reply> {
  const reply = await send(socketPath, method, path, json);
  if (reply.status >= 200 && reply.status < 300) return reply;
  let body: Partial<ErrorBody> = {};
  try {
    body = JSON.parse(reply.body.toString('utf8'));
  } catch {
    // Not JSON. The fallback message below covers it.
  }
  throw new ApiError(body.code ?? 'internal', body.error ?? `HTTP ${reply.status}`);
}

export async function callJson<T>(
  socketPath: string,
  method: string,
  path: string,
  json?: unknown,
): Promise<T> {
  const reply = await call(socketPath, method, path, json);
  return JSON.parse(reply.body.toString('utf8')) as T;
}
