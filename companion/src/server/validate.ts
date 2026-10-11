/** Request validation for the socket routes. Each check throws BadRequest. */

import type {
  DeleteRequest,
  DrawRequest,
  ElementUpdate,
  OpenRequest,
  SessionHost,
  SessionInfo,
  Skeleton,
  UpdateRequest,
} from '../protocol';
import type { Region } from './contract';

export class BadRequest extends Error {}

const SHAPE_TYPES = ['rectangle', 'ellipse', 'diamond', 'text', 'sticky', 'arrow', 'line', 'frame'];
const COLORS = ['black', 'gray', 'red', 'orange', 'yellow', 'green', 'blue', 'violet', 'pink'];
const NUMBER_FIELDS = ['x', 'y', 'width', 'height'] as const;

type Obj = Record<string, unknown>;

/** Matches the draft body limit in main/drafts.ts. */
const MAX_NOTE = 200_000;

function fail(message: string): never {
  throw new BadRequest(message);
}

function object(value: unknown, where: string): Obj {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`${where} must be an object`);
  }
  return value as Obj;
}

function optString(o: Obj, key: string, where: string): string | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'string') fail(`${where}.${key} must be a string`);
  return v;
}

function reqString(o: Obj, key: string, where: string): string {
  const v = optString(o, key, where);
  if (v === undefined || v === '') fail(`${where}.${key} is required`);
  return v;
}

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function checkNumbers(o: Obj, where: string): void {
  for (const key of NUMBER_FIELDS) {
    if (o[key] !== undefined && !finite(o[key])) fail(`${where}.${key} must be a finite number`);
  }
}

function checkColor(o: Obj, where: string): void {
  if (o.color !== undefined && !COLORS.includes(o.color as string)) {
    fail(`${where}.color must be one of ${COLORS.join(', ')}`);
  }
}

function checkEndpoint(v: unknown, where: string): void {
  const o = object(v, where);
  if (typeof o.id === 'string') return;
  if (finite(o.x) && finite(o.y)) return;
  fail(`${where} must be {id} or {x, y}`);
}

function checkSkeleton(v: unknown, i: number): Skeleton {
  const where = `elements[${i}]`;
  const o = object(v, where);
  if (!SHAPE_TYPES.includes(o.type as string)) {
    fail(`${where}.type must be one of ${SHAPE_TYPES.join(', ')}`);
  }
  optString(o, 'id', where);
  optString(o, 'label', where);
  optString(o, 'frameId', where);
  checkNumbers(o, where);
  checkColor(o, where);
  if (o.start !== undefined) checkEndpoint(o.start, `${where}.start`);
  if (o.end !== undefined) checkEndpoint(o.end, `${where}.end`);
  if (o.points !== undefined) {
    const ok =
      Array.isArray(o.points) &&
      o.points.every((p) => Array.isArray(p) && p.length === 2 && finite(p[0]) && finite(p[1]));
    if (!ok) fail(`${where}.points must be an array of [x, y] pairs`);
  }
  return o as unknown as Skeleton;
}

export function parseDraw(body: unknown): DrawRequest {
  const o = object(body, 'body');
  if (!Array.isArray(o.elements)) fail('body.elements must be an array');
  return { elements: o.elements.map(checkSkeleton) };
}

export function parseUpdate(body: unknown): UpdateRequest {
  const o = object(body, 'body');
  if (!Array.isArray(o.updates)) fail('body.updates must be an array');
  const updates = o.updates.map((v, i) => {
    const where = `updates[${i}]`;
    const u = object(v, where);
    reqString(u, 'id', where);
    optString(u, 'label', where);
    checkNumbers(u, where);
    checkColor(u, where);
    return u as unknown as ElementUpdate;
  });
  return { updates };
}

export function parseDelete(body: unknown): DeleteRequest {
  const o = object(body, 'body');
  if (!Array.isArray(o.ids) || !o.ids.every((id) => typeof id === 'string')) {
    fail('body.ids must be an array of strings');
  }
  return { ids: o.ids as string[] };
}

export function parseSession(body: unknown): SessionInfo {
  const o = object(body, 'body');
  const sessionId = reqString(o, 'sessionId', 'body');
  const cwd = reqString(o, 'cwd', 'body');
  const title = optString(o, 'title', 'body');
  if (o.pid !== undefined && !finite(o.pid)) fail('body.pid must be a finite number');
  const summary = optString(o, 'summary', 'body')?.slice(0, 200);
  let host: SessionHost | undefined;
  if (o.host !== undefined) {
    const h = object(o.host, 'body.host');
    host = {
      terminal: optString(h, 'terminal', 'body.host'),
      bundleId: optString(h, 'bundleId', 'body.host'),
      herdrPane: optString(h, 'herdrPane', 'body.host'),
    };
  }
  return { sessionId, cwd, title, pid: o.pid as number | undefined, summary, host };
}

export function parseOpen(body: unknown): OpenRequest {
  const o = object(body ?? {}, 'body');
  return {
    board: optString(o, 'board', 'body'),
    sessionId: optString(o, 'sessionId', 'body'),
    prompt: optString(o, 'prompt', 'body'),
    mode: openMode(o),
    text: openText(o),
  };
}

function openText(o: Obj): string | undefined {
  const text = optString(o, 'text', 'body');
  if (text !== undefined && text.length > MAX_NOTE) fail(`body.text must be under ${MAX_NOTE} characters`);
  return text;
}

function openMode(o: Obj): OpenRequest['mode'] {
  const mode = optString(o, 'mode', 'body');
  if (mode !== undefined && mode !== 'sketch' && mode !== 'write') fail('body.mode must be sketch or write');
  return mode;
}

/** Parses `x,y,w,h`. */
export function parseRegion(raw: string | null): Region | undefined {
  if (raw === null || raw === '') return undefined;
  const parts = raw.split(',').map(Number);
  if (parts.length !== 4 || !parts.every(finite)) fail('region must be x,y,w,h as numbers');
  const [x, y, width, height] = parts;
  return { x, y, width, height };
}

export function parseMaxEdge(raw: string | null): number | undefined {
  if (raw === null || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) fail('maxEdge must be a positive integer');
  return n;
}
