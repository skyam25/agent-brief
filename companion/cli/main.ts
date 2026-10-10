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
} from '../src/protocol';
import { formatBoards, formatRead, formatSessions, formatStatus } from './format';
import { commandHelp, DOCS, topHelp } from './help';
import { ApiError, call, callJson, NotRunningError } from './http';
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
  'Companion app is not running. Start it, or run /sketch in Claude Code.';

const EXIT = { ok: 0, server: 1, usage: 2, notRunning: 3 };

class UsageError extends Error {}

interface Args {
  flags: Map<string, string | true>;
  rest: string[];
}

const VALUE_FLAGS = new Set(['board', 'region', 'max-edge', 'out', 'file', 'prompt', 'session']);
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
    if (!DOCS[command]) throw new UsageError(`unknown command "${command}". Run "companion help".`);
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
    const elements = validateDraw(await readInput(ctx));
    const res = await callJson<DrawResponse>(ctx.socket, 'POST', boardPath(ctx, 'draw'), { elements });
    show(ctx, res, (r) => `drew ${r.ids.length} element${r.ids.length === 1 ? '' : 's'}, batch ${r.batchId}\nids: ${r.ids.join(' ')}`);
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
