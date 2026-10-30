/** Request validation for the socket routes. Each check throws BadRequest. */

import {
  INITIATIVE_ROLES,
  type InitiativeCreateRequest,
  type InitiativeFolder,
  type InitiativeRole,
  type InitiativeUpdateRequest,
  type SessionInitiativeRequest,
} from '../protocol';
import type {
  DeleteRequest,
  DrawRequest,
  ElementUpdate,
  ModePatch,
  NoteRequest,
  OpenRequest,
  PrototypeFidelity,
  SessionHost,
  SessionInfo,
  SessionMode,
  Skeleton,
  TrackingPatch,
  UpdateRequest,
} from '../protocol';
import { sectionBreak } from '../shared/brief-sections';
import { isMarkdownRef, isUrlRef } from '../shared/outputs';
import { opensInReview } from '../shared/review';
import type { Region } from './contract';

export class BadRequest extends Error {}

const SHAPE_TYPES = ['rectangle', 'ellipse', 'diamond', 'text', 'sticky', 'arrow', 'line', 'frame', 'image'];
export const IMAGE_DATA_URL = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+=*$/;
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
  if (o.align !== undefined && o.align !== 'left' && o.align !== 'center') fail(`${where}.align must be left or center`);
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
  if (o.type === 'image') {
    if (typeof o.image !== 'string' || !IMAGE_DATA_URL.test(o.image)) {
      fail(`${where}.image must be a base64 data URL of a png, jpeg, webp or gif`);
    }
    if (!finite(o.width) || !finite(o.height) || o.width <= 0 || o.height <= 0) {
      fail(`${where} needs a positive width and height`);
    }
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
  for (const key of ['activeAt', 'startedAt', 'promptAt'] as const) {
    if (o[key] !== undefined && !finite(o[key])) fail(`body.${key} must be a finite number`);
  }
  let host: SessionHost | undefined;
  if (o.host !== undefined) {
    const h = object(o.host, 'body.host');
    host = {
      terminal: optString(h, 'terminal', 'body.host'),
      bundleId: optString(h, 'bundleId', 'body.host'),
      herdrPane: optString(h, 'herdrPane', 'body.host'),
    };
  }
  return {
    sessionId,
    cwd,
    title,
    pid: o.pid as number | undefined,
    summary,
    activeAt: o.activeAt as number | undefined,
    startedAt: o.startedAt as number | undefined,
    promptAt: o.promptAt as number | undefined,
    host,
  };
}

const SESSION_MODES: SessionMode[] = ['default', 'product', 'prototype', 'orchestrate'];
const FIDELITIES: PrototypeFidelity[] = ['wireframe', 'styled', 'live-patch', 'freeze-patch', 'interactive', 'existing'];

/** PATCH /sessions/:id sets tracking, mode, or both. */
export interface SessionPatch {
  tracking?: TrackingPatch;
  mode?: ModePatch;
}

export function parseSessionPatch(body: unknown): SessionPatch {
  const o = object(body, 'body');
  if (o.trackItems === undefined && o.mode === undefined && o.fidelity === undefined) fail('body must set trackItems or mode');
  const patch: SessionPatch = {};
  if (o.trackItems !== undefined) {
    if (typeof o.trackItems !== 'boolean') fail('body.trackItems must be true or false');
    patch.tracking = { trackItems: o.trackItems as boolean };
  }
  if (o.mode !== undefined || o.fidelity !== undefined) patch.mode = parseMode(o);
  return patch;
}

function parseMode(o: Obj): ModePatch {
  const mode = o.mode as SessionMode;
  if (!SESSION_MODES.includes(mode)) fail(`body.mode must be one of ${SESSION_MODES.join(', ')}`);
  if (o.fidelity === undefined) return { mode };
  if (mode !== 'prototype') fail('body.fidelity goes only with mode prototype');
  const fidelity = o.fidelity as PrototypeFidelity;
  if (!FIDELITIES.includes(fidelity)) fail(`body.fidelity must be one of ${FIDELITIES.join(', ')}`);
  return { mode, fidelity };
}

export function parseOpen(body: unknown): OpenRequest {
  const o = object(body ?? {}, 'body');
  return {
    board: optString(o, 'board', 'body'),
    sessionId: optString(o, 'sessionId', 'body'),
    prompt: optString(o, 'prompt', 'body'),
    mode: openMode(o),
    text: openText(o),
    layout: openLayout(o),
    output: openOutput(o),
    note: openNote(o),
    reopen: openReopen(o),
    follow: openFollow(o),
  };
}

function openReopen(o: Obj): OpenRequest['reopen'] {
  if (o.reopen === undefined) return undefined;
  if (typeof o.reopen !== 'boolean') fail('body.reopen must be true or false');
  return o.reopen || undefined;
}

function openFollow(o: Obj): OpenRequest['follow'] {
  if (o.follow === undefined) return undefined;
  if (typeof o.follow !== 'boolean') fail('body.follow must be true or false');
  if (o.follow && (typeof o.board !== 'string' || typeof o.sessionId !== 'string')) fail('body.follow needs body.board and body.sessionId');
  return o.follow || undefined;
}

function openNote(o: Obj): OpenRequest['note'] {
  if (o.note === undefined) return undefined;
  const note = object(o.note, 'body.note');
  const id = reqString(note, 'id', 'body.note').trim();
  if (!id) fail('body.note.id is required');
  if (o.output !== undefined) fail('body.note and body.output open different things; send one');
  return { id };
}

/** An output to open. Its folder checks run in the app, which knows the session's files. */
function openOutput(o: Obj): OpenRequest['output'] {
  if (o.output === undefined) return undefined;
  const output = object(o.output, 'body.output');
  const path = reqString(output, 'path', 'body.output').trim();
  const tab = optString(output, 'tab', 'body.output');
  if (tab !== undefined && tab !== 'feedback') fail('body.output.tab must be feedback');
  if (tab === 'feedback' && isUrlRef(path)) fail('body.output.tab feedback needs a project file');
  if (tab !== 'feedback' && !isMarkdownRef(path) && !opensInReview(path)) fail('body.output.path must be a Markdown (.md, .markdown, .mdx) or HTML (.html, .htm) file, a local URL such as http://localhost:5173, or request its Feedback tab');
  if (!path) fail('body.output.path is required');
  if (o.sessionId === undefined) fail('body.output needs body.sessionId');
  return { path, ...(tab ? { tab } : {}) };
}

/** The longest note title, in characters. */
const MAX_NOTE_TITLE = 200;

export function parseNote(body: unknown): NoteRequest {
  const o = object(body ?? {}, 'body');
  const text = optString(o, 'text', 'body');
  if (text === undefined || text.trim() === '') fail('body.text is required');
  if (text.length > MAX_NOTE) fail(`body.text must be under ${MAX_NOTE} characters`);
  const title = optString(o, 'title', 'body')?.trim();
  if (title !== undefined && title.length > MAX_NOTE_TITLE) fail(`body.title must be under ${MAX_NOTE_TITLE} characters`);
  if (title?.includes('\n')) fail('body.title must be one line');
  const sessionId = optString(o, 'sessionId', 'body');
  const draftId = optString(o, 'draftId', 'body')?.trim();
  if (draftId !== undefined && !/^[\w-]{1,64}$/.test(draftId)) fail('body.draftId must be a note id');
  if (draftId) return { text, ...(title ? { title } : {}), draftId };
  return { text, ...(title ? { title } : {}), ...(sessionId ? { sessionId } : {}) };
}

function openLayout(o: Obj): OpenRequest['layout'] {
  const layout = optString(o, 'layout', 'body');
  if (layout !== undefined && layout !== 'freeform' && layout !== 'stack') fail('body.layout must be freeform or stack');
  return layout;
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

// ── Initiatives ───────────────────────────────────────────────────────────

const MAX_LINES = 500;
const MAX_LINE = 2000;
const MAX_TITLE = 120;

function oneLine(v: unknown, where: string): string {
  if (typeof v !== 'string') fail(`${where} must be a string`);
  const line = v.trim();
  if (line.includes('\n')) fail(`${where} must be one line`);
  if (line.length > MAX_LINE) fail(`${where} must be under ${MAX_LINE} characters`);
  return line;
}

function optLines(o: Obj, key: string, where: string): string[] | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) fail(`${where}.${key} must be an array of strings`);
  if (v.length > MAX_LINES) fail(`${where}.${key} takes at most ${MAX_LINES} lines`);
  return v.map((line, i) => oneLine(line, `${where}.${key}[${i}]`)).filter(Boolean);
}

function optFolders(o: Obj, where: string): InitiativeFolder[] | undefined {
  const v = o.folders;
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) fail(`${where}.folders must be an array`);
  if (v.length > MAX_LINES) fail(`${where}.folders takes at most ${MAX_LINES} rows`);
  return v.map((raw, i) => {
    const at = `${where}.folders[${i}]`;
    const f = object(raw, at);
    const path = oneLine(f.path, `${at}.path`);
    if (!path) fail(`${at}.path is required`);
    const role = f.role as InitiativeRole;
    if (!INITIATIVE_ROLES.includes(role)) fail(`${at}.role must be one of ${INITIATIVE_ROLES.join(', ')}`);
    const note = f.note === undefined ? '' : oneLine(f.note, `${at}.note`);
    return { path, role, ...(note ? { note } : {}) };
  });
}

function optUnderstanding(o: Obj, where: string): string | undefined {
  const text = optString(o, 'understanding', where);
  if (text === undefined) return undefined;
  if (text.length > MAX_NOTE) fail(`${where}.understanding must be under ${MAX_NOTE} characters`);
  const broken = sectionBreak(text);
  if (broken) fail(`${where}.understanding cannot be saved. ${broken}`);
  return text;
}

/** Keeps the fields that are set. */
const defined = <T extends object>(o: T): Partial<T> => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

export function parseInitiativeCreate(body: unknown): InitiativeCreateRequest {
  const o = object(body ?? {}, 'body');
  const title = reqString(o, 'title', 'body').replace(/\s+/g, ' ').trim();
  if (!title) fail('body.title is required');
  if (title.length > MAX_TITLE) fail(`body.title must be under ${MAX_TITLE} characters`);
  const folder = reqString(o, 'folder', 'body').trim();
  if (!folder.startsWith('/') && !folder.startsWith('~/')) fail('body.folder must be an absolute path');
  const updatedBy = optString(o, 'updatedBy', 'body');
  return {
    title,
    folder,
    ...defined({
      understanding: optUnderstanding(o, 'body'),
      folders: optFolders(o, 'body'),
      decisions: optLines(o, 'decisions', 'body'),
      open: optLines(o, 'open', 'body'),
      working: optLines(o, 'working', 'body'),
      updatedBy: updatedBy === undefined ? undefined : oneLine(updatedBy, 'body.updatedBy') || undefined,
    }),
  };
}

export function parseInitiativeUpdate(body: unknown): InitiativeUpdateRequest {
  const o = object(body ?? {}, 'body');
  if (!Number.isInteger(o.revision)) fail('body.revision must be the revision the change was made against');
  const updatedBy = oneLine(reqString(o, 'updatedBy', 'body'), 'body.updatedBy');
  if (!updatedBy) fail('body.updatedBy is required');
  return {
    revision: o.revision as number,
    updatedBy,
    ...defined({
      understanding: optUnderstanding(o, 'body'),
      decisions: optLines(o, 'decisions', 'body'),
      open: optLines(o, 'open', 'body'),
      folders: optFolders(o, 'body'),
    }),
  };
}

export function parseSessionInitiative(body: unknown): SessionInitiativeRequest {
  const o = object(body ?? {}, 'body');
  return { initiativeId: reqString(o, 'initiativeId', 'body').trim() };
}

/** `limit` for /initiatives/recent: 1 to 50, 3 when absent. */
export function parseLimit(raw: string | null): number {
  if (raw === null || raw === '') return 3;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 50) fail('limit must be an integer from 1 to 50');
  return n;
}
