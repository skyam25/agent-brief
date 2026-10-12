import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  CURRENT_BOARD,
  SOCKET_ENV,
  defaultSocketPath,
  type BoardsResponse,
  type DrawResponse,
  type Health,
  type MutateResponse,
  type OpenRequest,
  type OpenResponse,
  type ReadResponse,
  type SessionsResponse,
  type Skeleton,
} from '../src/protocol';
import { formatBoards, formatRead, formatSessions, formatStatus } from './format';
import { commandHelp, DOCS, topHelp } from './help';
import { ApiError, call, callJson, NotRunningError } from './http';
import { fitSize, loadImage } from './image';
import { InputError, parseRegion, validateDraw, validateUpdates } from './validate';

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
}

export const NOT_RUNNING_MESSAGE =
  'Agent Brief is not running. Start it, or run /sketch in Claude Code.';

const EXIT = { ok: 0, server: 1, usage: 2, notRunning: 3 };

class UsageError extends Error {}

interface Args {
  flags: Map<string, string | true>;
  rest: string[];
}

const VALUE_FLAGS = new Set(['board', 'region', 'max-edge', 'out', 'file', 'prompt', 'session', 'caption', 'note', 'width', 'layout']);
const BOOL_FLAGS = new Set(['json', 'help']);

function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string | true>();
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h') {
      flags.set('help', true);
    } else if (arg.startsWith('--') && arg.length > 2) {
      const [name, inline] = arg.slice(2).split(/=(.*)/s, 2);
      if (BOOL_FLAGS.has(name)) {
        flags.set(name, true);
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
  return { flags, rest };
}

function str(args: Args, name: string): string | undefined {
  const v = args.flags.get(name);
  return typeof v === 'string' ? v : undefined;
}

export async function main(argv: string[], io: IO): Promise<number> {
  const out = (s: string) => io.stdout(s.endsWith('\n') ? s : s + '\n');
  const err = (s: string) => io.stderr(s.endsWith('\n') ? s : s + '\n');

  try {
    const args = parseArgs(argv);
    const [command, ...positional] = args.rest;

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
      err(NOT_RUNNING_MESSAGE);
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

/** Prints a draw response, warnings included. */
function drawn(r: DrawResponse): string {
  const lines = [`drew ${r.ids.length} element${r.ids.length === 1 ? '' : 's'}, batch ${r.batchId}`, `ids: ${r.ids.join(' ')}`];
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

const COMMANDS: Record<string, (ctx: Ctx) => Promise<void>> = {
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
    const file = path.resolve(cwd, str(ctx.args, 'out') ?? `.feedback/boards/${safe}-${stamp}.png`);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, reply.body);
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
    show(ctx, res, (r) => `updated ${r.ids.length} element${r.ids.length === 1 ? '' : 's'}, batch ${r.batchId}\nids: ${r.ids.join(' ')}`);
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
