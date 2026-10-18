import type { BehaviorDocument, FeedbackDocument, FeedbackOp, FeedbackProject, FeedbackUpdateResult } from '../src/protocol';
import type { FeedbackWorkspace } from '../src/protocol';
import { behaviorMarkdown } from '../src/shared/behavior';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  CURRENT_BOARD,
  SOCKET_ENV,
  defaultSocketPath,
  type BoardsResponse,
  type DetachInitiativeResponse,
  type DrawResponse,
  type Health,
  type Initiative,
  type InitiativeCreateRequest,
  type InitiativeRevision,
  type InitiativeSnapshot,
  type InitiativeSummary,
  type InitiativeUpdateRequest,
  type MutateResponse,
  type NoteRequest,
  type NoteResponse,
  type OpenRequest,
  type OpenResponse,
  type ReadResponse,
  type SessionsResponse,
  type Skeleton,
  bashRequestLine,
} from '../src/protocol';
import { BOARD_PNG_KEEP, feedbackDir, trimPngs } from '../src/server/feedback-dir';
import { formatBoards, formatElement, formatRead, formatSessions, formatStatus } from './format';
import { commandHelp, DOCS, topHelp } from './help';
import { apply, FORCE_VAR, isOn, shellFiles } from './herdr';
import { ApiError, call, callJson, NotRunningError } from './http';
import { fitSize, loadImage } from './image';
import { formatFeedback, formatProject, formatRelated, itemHead, relatedView } from './feedback';
import { formatWorkspace } from './feedback';
import { DATA_DIR_ENV, defaultDataDir, formatInitiative, formatSummaries } from './initiative';
import { InputError, parseRegion, validateDraw, validateUpdates } from './validate';
import { InitiativeStore, resolveInitiative } from '../src/main/initiatives';

export interface IO {
  /** Reads all of stdin. */
  stdin: () => Promise<string>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: Record<string, string | undefined>;
  /** Base for relative paths. Defaults to process.cwd(). */
  cwd?: string;
  /** Clock for default file names. */
  now?: () => Date;
  /** Home directory for shell setup. Defaults to os.homedir(). */
  home?: string;
}

export const NOT_RUNNING_MESSAGE =
  'Agent Brief is not running. Start it, or run /sketch in Claude Code.';

export const NOTE_NOT_RUNNING_MESSAGE = 'Agent Brief is not running, so no note was made. Print the text instead.';

export const INITIATIVE_NOT_RUNNING_MESSAGE = 'Agent Brief is not running, so the initiative was not changed. Reads still work; changes need the app.';

/** Claude Code sets it in every shell it runs, so a note files under the session that wrote it. */
export const SESSION_ID_ENV = 'CLAUDE_CODE_SESSION_ID';

const EXIT = { ok: 0, server: 1, usage: 2, notRunning: 3 };

class UsageError extends Error {}

interface Args {
  flags: Map<string, string | true>;
  /** Every value of a flag that may repeat, in order. */
  lists: Map<string, string[]>;
  rest: string[];
}

const VALUE_FLAGS = new Set([
  'board', 'region', 'max-edge', 'out', 'file', 'prompt', 'session', 'caption', 'note', 'width', 'layout',
  'title', 'labels', 'url', 'path', 'status', 'text', 'limit', 'folder',
  'label', 'source', 'change', 'where', 'round', 'commit',
]);
/** Value flags that may repeat. */
const LIST_FLAGS = new Set(['src', 'related']);
const BOOL_FLAGS = new Set(['json', 'help']);

function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string | true>();
  const lists = new Map<string, string[]>();
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h') {
      flags.set('help', true);
    } else if (arg.startsWith('--') && arg.length > 2) {
      const [name, inline] = arg.slice(2).split(/=(.*)/s, 2);
      if (BOOL_FLAGS.has(name)) {
        flags.set(name, true);
      } else if (LIST_FLAGS.has(name)) {
        const value = inline ?? argv[++i];
        if (value === undefined) throw new UsageError(`--${name} needs a value`);
        lists.set(name, [...(lists.get(name) ?? []), value]);
      } else if (VALUE_FLAGS.has(name)) {
        const value = inline ?? argv[++i];
        if (value === undefined) throw new UsageError(`--${name} needs a value`);
        flags.set(name, value);
      } else {
        throw new UsageError(`unknown option --${name}`);
      }
    } else {
      rest.push(arg);
    }
  }
  return { flags, lists, rest };
}

function str(args: Args, name: string): string | undefined {
  const v = args.flags.get(name);
  return typeof v === 'string' ? v : undefined;
}

export async function main(argv: string[], io: IO): Promise<number> {
  const out = (s: string) => io.stdout(s.endsWith('\n') ? s : s + '\n');
  const err = (s: string) => io.stderr(s.endsWith('\n') ? s : s + '\n');

  let command: string | undefined;
  try {
    const args = parseArgs(argv);
    const [first, ...positional] = args.rest;
    command = first;

    if (!command || command === 'help' || (command === '--help')) {
      const topic = positional[0];
      out(topic && DOCS[topic] ? commandHelp(topic) : topHelp());
      return EXIT.ok;
    }
    if (!DOCS[command]) throw new UsageError(`unknown command "${command}". Run "agent-brief help".`);
    if (args.flags.has('help')) {
      out(commandHelp(command));
      return EXIT.ok;
    }

    const socket = io.env[SOCKET_ENV] || defaultSocketPath(os.homedir());
    const ctx = { args, positional, socket, io, out };
    await COMMANDS[command](ctx);
    return EXIT.ok;
  } catch (e) {
    if (e instanceof NotRunningError) {
      err(command === 'note' ? NOTE_NOT_RUNNING_MESSAGE : command === 'initiative' ? INITIATIVE_NOT_RUNNING_MESSAGE : NOT_RUNNING_MESSAGE);
      return EXIT.notRunning;
    }
    if (e instanceof ApiError) {
      err(`error (${e.code}): ${e.message}`);
      return EXIT.server;
    }
    if (e instanceof UsageError || e instanceof InputError) {
      err(`error: ${e.message}`);
      return EXIT.usage;
    }
    err(`error: ${e instanceof Error ? e.message : String(e)}`);
    return EXIT.server;
  }
}

interface Ctx {
  args: Args;
  positional: string[];
  socket: string;
  io: IO;
  out: (s: string) => void;
}

const boardPath = (ctx: Ctx, suffix: string) =>
  `/boards/${encodeURIComponent(str(ctx.args, 'board') ?? CURRENT_BOARD)}/${suffix}`;

const wantsJson = (ctx: Ctx) => ctx.args.flags.has('json');

/** Prints the response as JSON with --json, else as formatted text. */
function show<T>(ctx: Ctx, data: T, text: (d: T) => string): void {
  ctx.out(wantsJson(ctx) ? JSON.stringify(data) : text(data));
}

async function readInput(ctx: Ctx): Promise<unknown> {
  const file = str(ctx.args, 'file');
  const cwd = ctx.io.cwd ?? process.cwd();
  const text = file ? await readFile(path.resolve(cwd, file), 'utf8') : await ctx.io.stdin();
  if (text.trim() === '') throw new InputError(file ? `${file} is empty` : 'no JSON on stdin. Pipe it in or pass --file');
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new InputError(`invalid JSON: ${(e as Error).message}`);
  }
}

/** Swaps each image's `file` for its data URL and fills in a missing width or height. */
async function resolveImages(ctx: Ctx, elements: Skeleton[]): Promise<Skeleton[]> {
  const cwd = ctx.io.cwd ?? process.cwd();
  return Promise.all(
    elements.map(async (e) => {
      const file = (e as Skeleton & { file?: unknown }).file;
      if (e.type !== 'image' || typeof file !== 'string') return e;
      const { file: _path, ...rest } = e as Skeleton & { file: string };
      const img = await loadImage(file, cwd);
      return { ...rest, image: img.dataURL, ...fitSize(img, e.width, e.height) };
    }),
  );
}

/** Prints a draw response, one line per new element as `read` lists it, then warnings. */
function drawn(r: DrawResponse): string {
  const lines = [`drew ${r.ids.length} element${r.ids.length === 1 ? '' : 's'}, batch ${r.batchId}`];
  if (r.elements?.length) lines.push(...r.elements.map(formatElement));
  else lines.push(`ids: ${r.ids.join(' ')}`);
  for (const w of r.warnings ?? []) lines.push(`warning: ${w}`);
  return lines.join('\n');
}

/** Prints an update response, warnings included. */
function updated(r: MutateResponse): string {
  const lines = [`updated ${r.ids.length} element${r.ids.length === 1 ? '' : 's'}, batch ${r.batchId}`, `ids: ${r.ids.join(' ')}`];
  for (const w of r.warnings ?? []) lines.push(`warning: ${w}`);
  return lines.join('\n');
}

/** Snapshots per row before the next one starts a new row. */
const SNAPS_PER_ROW = 3;
const SNAP_GAP = 80;
const SNAP_PADDING = 20;
const SNAP_NOTE_HEIGHT = 100;
/** Room above a frame for its name. */
const FRAME_NAME_ROOM = 24;

/** Where the next snapshot frame goes: after the last one, three to a row, below anything else on the board. */
export function nextSnapSlot(board: ReadResponse): { x: number; y: number; step: number } {
  const imageFrames = new Set(
    board.elements.filter((e) => e.type === 'image' && e.by === 'claude' && e.frameId).map((e) => e.frameId!),
  );
  const snaps = board.elements.filter((e) => e.type === 'frame' && imageFrames.has(e.id));
  const n = snaps.length;
  if (n === 0) {
    const { bounds: b } = board;
    const empty = b.width === 0 && b.height === 0;
    return { x: empty ? 0 : b.x, y: empty ? 0 : b.y + b.height + SNAP_GAP + FRAME_NAME_ROOM, step: 1 };
  }
  const last = snaps[n - 1];
  if (n % SNAPS_PER_ROW !== 0) return { x: last.x + last.width + SNAP_GAP, y: last.y, step: n + 1 };
  const rowStart = snaps[n - SNAPS_PER_ROW];
  const bottom = Math.max(...snaps.map((s) => s.y + s.height));
  return { x: rowStart.x, y: bottom + SNAP_GAP + FRAME_NAME_ROOM, step: n + 1 };
}

function regionQuery(ctx: Ctx, extra: string[] = []): string {
  const region = str(ctx.args, 'region');
  const parts = region ? [`region=${parseRegion(region)}`] : [];
  const q = [...parts, ...extra].join('&');
  return q ? `?${q}` : '';
}

/** Shows a path under the home directory as ~/... */
const tilde = (home: string, p: string) => (p.startsWith(home + path.sep) ? '~' + p.slice(home.length) : p);

// ── Initiatives ───────────────────────────────────────────────────────────

/** Asks the app, else reads the index and the brief files straight from disk. */
async function initiativeRead<T>(ctx: Ctx, route: string, offline: (store: InitiativeStore) => T): Promise<T> {
  try {
    return await callJson<T>(ctx.socket, 'GET', route);
  } catch (e) {
    if (!(e instanceof NotRunningError)) throw e;
    const home = ctx.io.home ?? os.homedir();
    return offline(new InitiativeStore(ctx.io.env[DATA_DIR_ENV] || defaultDataDir(home), { readOnly: true, home }));
  }
}

const allInitiatives = (ctx: Ctx) => initiativeRead<InitiativeSummary[]>(ctx, '/initiatives', (s) => s.list());

/** The initiative an id or title names, or an error naming the list command. */
async function initiativeNamed(ctx: Ctx, key: string): Promise<InitiativeSummary> {
  if (!key.trim()) throw new UsageError('name an initiative by its id or title');
  const found = resolveInitiative(await allInitiatives(ctx), key);
  if (!found) throw new ApiError('not_found', `no initiative matches "${key}". Run "agent-brief initiative list".`);
  return found;
}

/** --session, else the Claude Code session running the command. */
function initiativeSession(ctx: Ctx, verb: string): string {
  const id = str(ctx.args, 'session') ?? ctx.io.env[SESSION_ID_ENV];
  if (!id) throw new UsageError(`${verb} needs --session <id>, or run it from Claude Code`);
  return id;
}

/** `Claude · <session>` from Claude Code's shell, else `PM`. */
const initiativeAuthor = (ctx: Ctx) => (ctx.io.env[SESSION_ID_ENV] ? `Claude · ${ctx.io.env[SESSION_ID_ENV]}` : 'PM');

async function readJsonObject(ctx: Ctx): Promise<Record<string, unknown>> {
  const value = await readInput(ctx);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new InputError('the JSON must be an object');
  return value as Record<string, unknown>;
}

const INITIATIVE_VERBS: Record<string, (ctx: Ctx, words: string[]) => Promise<void>> = {
  async list(ctx) {
    show(ctx, await allInitiatives(ctx), (l) => formatSummaries(l, 'no initiatives'));
  },

  async recent(ctx) {
    const raw = str(ctx.args, 'limit') ?? '3';
    const limit = Number(raw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new UsageError(`--limit must be 1 to 50, got "${raw}"`);
    const res = await initiativeRead(ctx, `/initiatives/recent?limit=${limit}`, (s) => s.recent(limit));
    show(ctx, res, (l) => formatSummaries(l, 'no initiatives'));
  },

  async find(ctx, words) {
    const q = words.join(' ').trim();
    if (!q) throw new UsageError('find needs words to match');
    const res = await initiativeRead(ctx, `/initiatives/find?q=${encodeURIComponent(q)}`, (s) => s.find(q));
    show(ctx, res, (l) => formatSummaries(l, 'no match. Run "agent-brief initiative list" to see them all.'));
  },

  async show(ctx, words) {
    const { id } = await initiativeNamed(ctx, words.join(' '));
    const at = `/initiatives/${encodeURIComponent(id)}`;
    const initiative = await initiativeRead<Initiative>(ctx, at, (s) => s.get(id));
    const history = await initiativeRead<InitiativeRevision[]>(ctx, `${at}/history`, (s) => s.history(id));
    show(ctx, { ...initiative, history }, () => formatInitiative(initiative, history));
  },

  async attach(ctx, words) {
    const session = initiativeSession(ctx, 'attach');
    const { id } = await initiativeNamed(ctx, words.join(' '));
    const snap = await callJson<InitiativeSnapshot>(ctx.socket, 'PUT', `/sessions/${encodeURIComponent(session)}/initiative`, { initiativeId: id });
    show(ctx, snap, (s) => `attached "${s.title}" (revision ${s.revision}) to session ${session}`);
  },

  async detach(ctx) {
    const session = initiativeSession(ctx, 'detach');
    const res = await callJson<DetachInitiativeResponse>(ctx.socket, 'DELETE', `/sessions/${encodeURIComponent(session)}/initiative`);
    show(ctx, res, (r) => (r.detached ? `detached session ${session}` : `session ${session} had no initiative`));
  },

  async create(ctx, words) {
    const title = words.join(' ').trim();
    if (!title) throw new UsageError('create needs a title');
    const raw = str(ctx.args, 'folder');
    if (!raw) throw new UsageError('create needs --folder <path>');
    const folder = raw.startsWith('~/') ? raw : path.resolve(ctx.io.cwd ?? process.cwd(), raw);
    const draft = str(ctx.args, 'file') ? await readJsonObject(ctx) : {};
    const body: InitiativeCreateRequest = { updatedBy: initiativeAuthor(ctx), ...draft, title, folder };
    const res = await callJson<Initiative>(ctx.socket, 'POST', '/initiatives', body);
    show(ctx, res, (i) => `created "${i.title}" (id ${i.id}) at ${i.path}`);
  },

  async update(ctx, words) {
    const { id } = await initiativeNamed(ctx, words.join(' '));
    const patch = await readJsonObject(ctx);
    if (!Number.isInteger(patch.revision)) {
      throw new InputError('the JSON needs "revision", the one you read. "agent-brief initiative show" prints it.');
    }
    const body = { updatedBy: initiativeAuthor(ctx), ...patch } as InitiativeUpdateRequest;
    const res = await callJson<Initiative>(ctx.socket, 'PUT', `/initiatives/${encodeURIComponent(id)}`, body);
    show(ctx, res, (i) => `updated "${i.title}" to revision ${i.revision}`);
  },
};

// ── Feedback ──────────────────────────────────────────────────────────────

/** --session, else the Claude Code session running the command. */
function feedbackSession(ctx: Ctx): string {
  const id = str(ctx.args, 'session') ?? ctx.io.env[SESSION_ID_ENV];
  if (!id) throw new UsageError('feedback needs --session <id>, or run it from Claude Code');
  return id;
}

const feedbackRoute = (ctx: Ctx, output?: string) =>
  `/sessions/${encodeURIComponent(feedbackSession(ctx))}/feedback${output === undefined ? '' : `?path=${encodeURIComponent(output)}`}`;

const readFeedbackDoc = (ctx: Ctx, output: string) => callJson<FeedbackDocument>(ctx.socket, 'GET', feedbackRoute(ctx, output));

/** Reads the version and applies the ops. Ops only add, so a write that lost a race reads again and retries once. */
async function writeFeedback(ctx: Ctx, output: string, ops: FeedbackOp[]): Promise<FeedbackUpdateResult> {
  for (let attempt = 0; ; attempt++) {
    const { version } = await readFeedbackDoc(ctx, output);
    try {
      return await callJson<FeedbackUpdateResult>(ctx.socket, 'POST', feedbackRoute(ctx, output), { version, ops });
    } catch (e) {
      if (!(e instanceof ApiError && e.code === 'conflict') || attempt > 0) throw e;
    }
  }
}

function itemNumber(raw: string | undefined, verb: string): number {
  const n = Number(raw?.replace(/^#/, ''));
  if (!Number.isInteger(n) || n < 1) throw new UsageError(`${verb} needs an item number, got "${raw ?? ''}"`);
  return n;
}

/** Every readable feedback document in the project. */
async function projectDocs(ctx: Ctx): Promise<FeedbackDocument[]> {
  const project = await callJson<FeedbackProject>(ctx.socket, 'GET', `${feedbackRoute(ctx)}/project`);
  const docs = await Promise.all(project.files.filter((f) => f.outputExists).map((f) => readFeedbackDoc(ctx, f.output).catch(() => undefined)));
  return docs.filter((d): d is FeedbackDocument => !!d);
}

const FEEDBACK_VERBS: Record<string, (ctx: Ctx, output: string, words: string[]) => Promise<void>> = {
  async show(ctx, output) {
    show(ctx, await readFeedbackDoc(ctx, output), formatFeedback);
  },

  async round(ctx, output) {
    const label = str(ctx.args, 'label');
    if (!label) throw new UsageError('round needs --label, such as "SME" or "customers"');
    const source = str(ctx.args, 'source');
    const res = await writeFeedback(ctx, output, [{ op: 'addRound', label, ...(source ? { source } : {}) }]);
    show(ctx, res, (d) => `added round ${d.added.rounds[0]} to ${d.path}`);
  },

  async add(ctx, output) {
    const title = str(ctx.args, 'title');
    if (!title) throw new UsageError('add needs --title');
    const rawRound = str(ctx.args, 'round');
    const round = rawRound === undefined ? undefined : Number(rawRound);
    if (round !== undefined && !Number.isInteger(round)) throw new UsageError(`--round must be a round number, got "${rawRound}"`);
    const one = (key: string, flag: string) => { const v = str(ctx.args, flag); return v === undefined ? [] : [{ key, text: v }]; };
    const lines = [
      ...(ctx.args.lists.get('src') ?? []).map((text) => ({ key: 'Src', text })),
      ...one('Change', 'change'),
      ...one('Where', 'where'),
      ...(ctx.args.lists.get('related') ?? []).map((text) => ({ key: 'Related', text })),
    ];
    const res = await writeFeedback(ctx, output, [{ op: 'addItem', title, ...(round !== undefined ? { round } : {}), ...(lines.length ? { lines } : {}) }]);
    const n = res.added.items[0];
    show(ctx, res, (d) => `added ${itemHead(d.items.find((i) => i.n === n)!)} to ${d.path}`);
  },

  async log(ctx, output, [rawN, key, ...words]) {
    const n = itemNumber(rawN, 'log');
    const text = words.join(' ').trim();
    if (!key || !text) throw new UsageError('log needs <n> <key> <text>, such as: log page.html 6 Claude "note · asked about mobile"');
    const res = await writeFeedback(ctx, output, [{ op: 'append', item: n, key, text }]);
    show(ctx, res, (d) => `logged ${key} on ${itemHead(d.items.find((i) => i.n === n)!)}`);
  },

  async done(ctx, output, [rawN, ...words]) {
    const n = itemNumber(rawN, 'done');
    const commit = str(ctx.args, 'commit');
    const text = ['done', words.join(' ').trim(), commit ? `commit ${commit}` : ''].filter(Boolean).join(' · ');
    const res = await writeFeedback(ctx, output, [{ op: 'append', item: n, key: 'Claude', text }, { op: 'close', item: n }]);
    show(ctx, res, (d) => `closed ${itemHead(d.items.find((i) => i.n === n)!)}`);
  },

  async related(ctx, output, [rawN]) {
    const text = str(ctx.args, 'text');
    if ((rawN === undefined) === (text === undefined)) throw new UsageError('related needs an item number or --text <the point>');
    const n = rawN === undefined ? undefined : itemNumber(rawN, 'related');
    const docs = await projectDocs(ctx);
    const own = await readFeedbackDoc(ctx, output);
    if (!docs.some((d) => d.output === own.output)) docs.push(own);
    if (n !== undefined && !own.items.some((i) => i.n === n)) throw new ApiError('not_found', `${own.path} has no item #${n}`);
    show(ctx, relatedView(docs, own.output, { n, text }), (v) => formatRelated(v, own.output));
  },

  async workspace(ctx, output, [rawN]) {
    const n = itemNumber(rawN, 'workspace');
    const route = `/sessions/${encodeURIComponent(feedbackSession(ctx))}/feedback/workspace?path=${encodeURIComponent(output)}&item=${n}`;
    const res = await callJson<FeedbackWorkspace>(ctx.socket, 'POST', route);
    show(ctx, res, formatWorkspace);
  },
};

const COMMANDS: Record<string, (ctx: Ctx) => Promise<void>> = {
  // `show` and `output` print a request line for the mod's Bash hook, which draws or records it.
  // They need no app, so they work where a policy stops the mod's own tools.

  async show(ctx) {
    const files = ctx.positional;
    if (files.length === 0) throw new UsageError('show needs a picture file');
    if (files.length > 4) throw new UsageError('show takes at most 4 pictures');
    const cwd = ctx.io.cwd ?? process.cwd();
    const labels = str(ctx.args, 'labels')?.split('|').map((l) => l.trim());
    const items = files.map((f, i) => ({ path: path.resolve(cwd, f), ...(labels?.[i] ? { title: labels[i] } : {}) }));
    const title = str(ctx.args, 'title');
    const board = str(ctx.args, 'board');
    const url = str(ctx.args, 'url');
    const extras = { ...(board ? { board } : {}), ...(url ? { url } : {}) };
    const input =
      items.length === 1
        ? { ...items[0], ...(title ? { title } : {}), ...extras }
        : { options: items, ...(title ? { title } : {}), ...extras };
    ctx.out(bashRequestLine({ kind: 'show', input }));
    ctx.out('Agent Brief draws this when its plugin runs in this Claude Code session. Without the plugin, nothing is shown.');
  },

  async output(ctx) {
    const title = ctx.positional.join(' ').trim();
    if (title === '') throw new UsageError('output needs a title');
    const file = str(ctx.args, 'path');
    const url = str(ctx.args, 'url');
    if ((file === undefined) === (url === undefined)) throw new UsageError('output needs exactly one of --path or --url');
    const status = str(ctx.args, 'status') ?? 'drafting';
    if (status !== 'drafting' && status !== 'ready') throw new UsageError('--status is drafting or ready');
    const cwd = ctx.io.cwd ?? process.cwd();
    const where = file !== undefined ? { path: path.resolve(cwd, file) } : { url: url! };
    ctx.out(bashRequestLine({ kind: 'output', input: { title, ...where, status } }));
    ctx.out('Agent Brief records this when its plugin runs in this Claude Code session. Without the plugin, nothing is recorded.');
  },

  async note(ctx) {
    const title = ctx.positional.join(' ').trim();
    const inline = str(ctx.args, 'text');
    const file = str(ctx.args, 'file');
    if (inline !== undefined && file !== undefined) throw new UsageError('note takes --text or --file, not both');
    const cwd = ctx.io.cwd ?? process.cwd();
    const text = inline ?? (file !== undefined ? await readFile(path.resolve(cwd, file), 'utf8') : await ctx.io.stdin());
    if (text.trim() === '') throw new InputError(file ? `${file} is empty` : 'no text. Pipe Markdown in, or pass --text or --file');
    const flag = str(ctx.args, 'session');
    const fromEnv = flag === undefined ? ctx.io.env[SESSION_ID_ENV] || undefined : undefined;
    const body: NoteRequest = { text, ...(title ? { title } : {}) };
    const post = (sessionId?: string) =>
      callJson<NoteResponse>(ctx.socket, 'POST', '/notes', { ...body, ...(sessionId ? { sessionId } : {}) });
    let filed = flag ?? fromEnv;
    let res: NoteResponse;
    try {
      res = await post(filed);
    } catch (e) {
      // A session from the environment the app has not met yet still gets its note, under Notes.
      if (!(fromEnv && e instanceof ApiError && e.code === 'not_found')) throw e;
      filed = undefined;
      res = await post();
    }
    const where = filed ? "this session's tab" : 'Notes';
    show(ctx, { ...res, ...(filed ? { sessionId: filed } : {}) }, () =>
      `Saved "${title || 'Untitled note'}" to ${where} in Agent Brief, Write mode. The user can edit it there and press Copy.`,
    );
  },

  async 'herdr-pictures'(ctx) {
    const action = ctx.positional[0] ?? 'status';
    if (action !== 'on' && action !== 'off' && action !== 'status') {
      throw new UsageError(`herdr-pictures takes on, off or status, got "${action}"`);
    }
    const home = ctx.io.home ?? os.homedir();
    const files = shellFiles(ctx.io.env, home);
    const shown = (p: string) => tilde(home, p);

    if (action === 'status') {
      const lines = await Promise.all(files.map(async (f) => `${(await isOn(f)) ? 'on ' : 'off'}  ${shown(f.path)}`));
      lines.push(`${ctx.io.env[FORCE_VAR] ? 'on ' : 'off'}  this shell`);
      ctx.out(lines.join('\n'));
      return;
    }

    const on = action === 'on';
    const lines: string[] = [];
    for (const f of files) {
      const change = await apply(f, on);
      const verb = { added: 'added to', already: 'already in', removed: 'removed from', absent: 'not in' }[change];
      lines.push(`${verb} ${shown(f.path)}`);
    }
    if (on) {
      lines.push(
        '',
        'New Herdr panes pick this up. Restart Claude in a new pane, or in this one after running:',
        `  export ${FORCE_VAR}=1`,
      );
    } else {
      lines.push('', 'New Herdr panes no longer force pictures on.');
    }
    ctx.out(lines.join('\n'));
  },

  async initiative(ctx) {
    const [verb, ...words] = ctx.positional;
    const run = verb ? INITIATIVE_VERBS[verb] : undefined;
    if (!run) throw new UsageError(`initiative takes ${Object.keys(INITIATIVE_VERBS).join(', ')}. Run "agent-brief initiative --help".`);
    await run(ctx, words);
  },

  async behavior(ctx) {
    const [verb, html] = ctx.positional;
    if (!['show', 'update', 'export'].includes(verb) || !html) throw new UsageError('behavior needs show|update|export and a project-relative HTML path');
    const session = str(ctx.args, 'session') ?? ctx.io.env[SESSION_ID_ENV];
    if (!session) throw new UsageError('behavior needs --session or CLAUDE_CODE_SESSION_ID');
    const route = `/sessions/${encodeURIComponent(session)}/behavior?path=${encodeURIComponent(html)}`;
    const doc = await callJson<BehaviorDocument>(ctx.socket, verb === 'update' ? 'PUT' : 'GET', route, verb === 'update' ? await readInput(ctx) : undefined);
    if (verb === 'export') {
      const markdown = behaviorMarkdown(doc) + '\n';
      const dest = str(ctx.args, 'out');
      if (dest) { await writeFile(path.resolve(ctx.io.cwd ?? process.cwd(), dest), markdown); ctx.out(dest); }
      else ctx.out(markdown);
    } else show(ctx, doc, (d) => `${d.path} · revision ${d.revision} · version ${d.version}\n${d.rules.map((r) => `[${r.status}] ${r.id}: ${r.text}`).join('\n')}`);
  },

  async feedback(ctx) {
    const [verb, output, ...words] = ctx.positional;
    if (verb === 'list') {
      const res = await callJson<FeedbackProject>(ctx.socket, 'GET', `${feedbackRoute(ctx)}/project`);
      show(ctx, res, formatProject);
      return;
    }
    const run = verb ? FEEDBACK_VERBS[verb] : undefined;
    if (!run) throw new UsageError(`feedback takes list, ${Object.keys(FEEDBACK_VERBS).join(', ')}. Run "agent-brief feedback --help".`);
    if (!output) throw new UsageError(`feedback ${verb} needs a project-relative output path`);
    await run(ctx, output, words);
  },

  async status(ctx) {
    const health = await callJson<Health>(ctx.socket, 'GET', '/health');
    show(ctx, health, formatStatus);
  },

  async sessions(ctx) {
    const res = await callJson<SessionsResponse>(ctx.socket, 'GET', '/sessions');
    show(ctx, res, formatSessions);
  },

  async boards(ctx) {
    const res = await callJson<BoardsResponse>(ctx.socket, 'GET', '/boards');
    show(ctx, res, formatBoards);
  },

  async open(ctx) {
    const body: OpenRequest = {};
    const board = str(ctx.args, 'board');
    const prompt = str(ctx.args, 'prompt');
    const sessionId = str(ctx.args, 'session');
    const layout = str(ctx.args, 'layout');
    if (layout !== undefined && layout !== 'freeform' && layout !== 'stack') {
      throw new UsageError(`--layout must be freeform or stack, got "${layout}"`);
    }
    if (layout) body.layout = layout;
    if (board) body.board = board;
    if (prompt) body.prompt = prompt;
    if (sessionId) body.sessionId = sessionId;
    const res = await callJson<OpenResponse>(ctx.socket, 'POST', '/open', body);
    show(ctx, res, (r) =>
      `opened board ${JSON.stringify(r.board)}` +
      (r.targetSessionId ? `, send target ${r.targetSessionId}` : ''),
    );
  },

  async read(ctx) {
    const res = await callJson<ReadResponse>(
      ctx.socket, 'GET', boardPath(ctx, 'elements') + regionQuery(ctx),
    );
    show(ctx, res, formatRead);
  },

  async png(ctx) {
    const maxEdge = str(ctx.args, 'max-edge');
    if (maxEdge !== undefined && !(Number.isInteger(Number(maxEdge)) && Number(maxEdge) > 0)) {
      throw new UsageError(`--max-edge must be a positive integer, got "${maxEdge}"`);
    }
    const query = regionQuery(ctx, maxEdge ? [`maxEdge=${maxEdge}`] : []);
    const reply = await call(ctx.socket, 'GET', boardPath(ctx, 'png') + query);

    const cwd = ctx.io.cwd ?? process.cwd();
    const board = str(ctx.args, 'board') ?? CURRENT_BOARD;
    const stamp = (ctx.io.now?.() ?? new Date()).toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
    const safe = board.replace(/[^\w.-]+/g, '_');
    const out = str(ctx.args, 'out');
    const file = out ? path.resolve(cwd, out) : path.join(feedbackDir(cwd), 'boards', `${safe}-${stamp}.png`);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, reply.body);
    if (!out) trimPngs(path.dirname(file), BOARD_PNG_KEEP);
    show(ctx, { path: file, bytes: reply.body.length }, (r) => r.path);
  },

  async draw(ctx) {
    const elements = await resolveImages(ctx, validateDraw(await readInput(ctx)));
    const res = await callJson<DrawResponse>(ctx.socket, 'POST', boardPath(ctx, 'draw'), { elements });
    show(ctx, res, drawn);
  },

  async snap(ctx) {
    const file = ctx.positional[0];
    if (!file) throw new UsageError('snap needs an image file');
    const widthFlag = str(ctx.args, 'width');
    const width = widthFlag === undefined ? undefined : Number(widthFlag);
    if (width !== undefined && !(Number.isInteger(width) && width > 0)) {
      throw new UsageError(`--width must be a positive integer, got "${widthFlag}"`);
    }
    const img = await loadImage(file, ctx.io.cwd ?? process.cwd());
    const size = fitSize(img, width);
    const board = await callJson<ReadResponse>(ctx.socket, 'GET', boardPath(ctx, 'elements'));
    const { x, y, step } = nextSnapSlot(board);
    const caption = str(ctx.args, 'caption');
    const note = str(ctx.args, 'note');
    const p = SNAP_PADDING;
    const elements: Skeleton[] = [
      {
        id: 'snap',
        type: 'frame',
        x,
        y,
        width: size.width + 2 * p,
        height: size.height + 2 * p + (note ? SNAP_NOTE_HEIGHT + p : 0),
        label: caption ? `${step}. ${caption}` : `Step ${step}`,
      },
      { id: 'shot', type: 'image', x: x + p, y: y + p, ...size, image: img.dataURL, frameId: 'snap' },
    ];
    if (note) {
      elements.push({
        id: 'note',
        type: 'sticky',
        x: x + p,
        y: y + p + size.height + p,
        width: Math.min(size.width, 420),
        height: SNAP_NOTE_HEIGHT,
        label: note,
        frameId: 'snap',
      });
    }
    const res = await callJson<DrawResponse>(ctx.socket, 'POST', boardPath(ctx, 'draw'), { elements });
    show(ctx, { ...res, step }, (r) => {
      const [frame, shot, sticky] = r.ids;
      return `snapshot ${step} at ${x},${y} · frame ${frame} · image ${shot}${sticky ? ` · note ${sticky}` : ''}`;
    });
  },

  async update(ctx) {
    const updates = validateUpdates(await readInput(ctx));
    const res = await callJson<MutateResponse>(ctx.socket, 'PATCH', boardPath(ctx, 'elements'), { updates });
    show(ctx, res, updated);
  },

  async delete(ctx) {
    if (ctx.positional.length === 0) throw new UsageError('delete needs at least one id');
    const res = await callJson<MutateResponse>(ctx.socket, 'DELETE', boardPath(ctx, 'elements'), { ids: ctx.positional });
    show(ctx, res, (r) => {
      const missing = ctx.positional.filter((id) => !r.ids.includes(id));
      return (
        `deleted ${r.ids.length} element${r.ids.length === 1 ? '' : 's'}, batch ${r.batchId}\nids: ${r.ids.join(' ')}` +
        (missing.length ? `\nnot found: ${missing.join(' ')}` : '')
      );
    });
  },
};
