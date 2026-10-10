import type { ColorName, ElementUpdate, Skeleton } from '../src/protocol';

/** A problem in user input. The message names the offending index. */
export class InputError extends Error {}

const TYPES = ['rectangle', 'ellipse', 'diamond', 'text', 'sticky', 'arrow', 'line', 'frame'];
const COLORS: ColorName[] = [
  'black', 'gray', 'red', 'orange', 'yellow', 'green', 'blue', 'violet', 'pink',
];
const NUMBER_FIELDS = ['x', 'y', 'width', 'height'] as const;

type Obj = Record<string, unknown>;

function isObject(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function describe(v: unknown): string {
  return JSON.stringify(v) ?? String(v);
}

/** Takes `{key: [...]}` or a bare array and returns the array. */
export function unwrap(input: unknown, key: string): unknown[] {
  if (Array.isArray(input)) return input;
  if (isObject(input) && Array.isArray(input[key])) return input[key] as unknown[];
  throw new InputError(`expected {"${key}": [...]} or a bare array`);
}

function checkEndpoint(at: string, name: string, v: unknown): void {
  if (!isObject(v)) throw new InputError(`${at}: "${name}" must be {"id": "..."} or {"x": n, "y": n}`);
  if (typeof v.id === 'string') return;
  if (isNumber(v.x) && isNumber(v.y)) return;
  throw new InputError(`${at}: "${name}" must be {"id": "..."} or {"x": n, "y": n}, got ${describe(v)}`);
}

function checkShared(at: string, e: Obj): void {
  for (const f of NUMBER_FIELDS) {
    if (e[f] !== undefined && !isNumber(e[f])) {
      throw new InputError(`${at}: "${f}" must be a number, got ${describe(e[f])}`);
    }
  }
  if (e.label !== undefined && typeof e.label !== 'string') {
    throw new InputError(`${at}: "label" must be a string, got ${describe(e.label)}`);
  }
  if (e.color !== undefined && !COLORS.includes(e.color as ColorName)) {
    throw new InputError(`${at}: unknown color ${describe(e.color)}. Use ${COLORS.join(', ')}`);
  }
}

export function validateDraw(input: unknown): Skeleton[] {
  const list = unwrap(input, 'elements');
  if (list.length === 0) throw new InputError('no elements to draw');
  list.forEach((e, i) => {
    const at = `elements[${i}]`;
    if (!isObject(e)) throw new InputError(`${at}: must be an object`);
    if (typeof e.type !== 'string' || !TYPES.includes(e.type)) {
      throw new InputError(`${at}: "type" must be one of ${TYPES.join(', ')}, got ${describe(e.type)}`);
    }
    if (e.id !== undefined && typeof e.id !== 'string') {
      throw new InputError(`${at}: "id" must be a string, got ${describe(e.id)}`);
    }
    if (e.frameId !== undefined && typeof e.frameId !== 'string') {
      throw new InputError(`${at}: "frameId" must be a string, got ${describe(e.frameId)}`);
    }
    checkShared(at, e);
    if (e.start !== undefined) checkEndpoint(at, 'start', e.start);
    if (e.end !== undefined) checkEndpoint(at, 'end', e.end);
    if (e.points !== undefined) {
      const ok =
        Array.isArray(e.points) &&
        e.points.every((p) => Array.isArray(p) && p.length === 2 && p.every(isNumber));
      if (!ok) throw new InputError(`${at}: "points" must be an array of [x, y] number pairs`);
    }
    if ((e.type === 'arrow' || e.type === 'line') && !e.start && !e.points) {
      throw new InputError(`${at}: ${e.type} needs "start" and "end" (or "points")`);
    }
  });
  return list as Skeleton[];
}

export function validateUpdates(input: unknown): ElementUpdate[] {
  const list = unwrap(input, 'updates');
  if (list.length === 0) throw new InputError('no updates to apply');
  list.forEach((u, i) => {
    const at = `updates[${i}]`;
    if (!isObject(u)) throw new InputError(`${at}: must be an object`);
    if (typeof u.id !== 'string' || u.id === '') {
      throw new InputError(`${at}: "id" must be a non-empty string, got ${describe(u.id)}`);
    }
    checkShared(at, u);
  });
  return list as ElementUpdate[];
}

/** Parses `x,y,w,h` with a positive width and height. */
export function parseRegion(text: string): string {
  const parts = text.split(',').map((s) => Number(s.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n)) || parts[2] <= 0 || parts[3] <= 0) {
    throw new InputError(`--region must be x,y,w,h with positive w and h, got "${text}"`);
  }
  return parts.join(',');
}
