/** `agent-brief outline`: list, make, show and change `<name>.outline.md` files through the app. */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { OpenRequest, OpenResponse, OutlineDocument, OutlineKind, OutlineOp, OutlineProject, OutlineSummary, OutlineUpdateResult } from '../src/protocol';
import { cleanOutlineOps, isOutlinePath, OutlineOpError, outlinePathFor, outlineSlugPath, serializeOutline } from '../src/shared/outline';
import { ApiError, callJson } from './http';
import { InputError } from './validate';

export interface OutlineCtx {
  socket: string;
  /** The verb and the words after it. */
  positional: string[];
  flag: (name: string) => string | undefined;
  has: (name: string) => boolean;
  /** --session, else the Claude Code session running the command. */
  session?: string;
  cwd: string;
  stdin: () => Promise<string>;
  out: (s: string) => void;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** `docs/memo.outline.md · "Onboarding memo" · docs/memo.md · 3 sections · 9 points · 1 open · 2 unchecked · 0 flagged`. */
export const summaryLine = (s: OutlineSummary) =>
  [
    s.path,
    JSON.stringify(s.title),
    s.target ?? `no target (${s.kind})`,
    plural(s.sections, 'section'),
    plural(s.points, 'point'),
    `${s.open} open`,
    `${s.unchecked} unchecked`,
    `${s.flagged} flagged`,
    ...(s.direction ? [`direction ${s.direction}`] : []),
  ].join(' · ');

export function formatOutlineProject(project: OutlineProject): string {
  if (!project.files.length) return 'no outlines in this project. Make one with "agent-brief outline new".';
  const lines = project.files.map(summaryLine);
  if (project.truncated) lines.push('(the scan stopped early; some files are not listed)');
  return lines.join('\n');
}

export function formatOutline(doc: OutlineDocument): string {
  if (doc.version === 'missing') return `${doc.path} · no outline yet. Make one with "agent-brief outline new".`;
  return `${doc.path} · version ${doc.version}\n${serializeOutline(doc)}`;
}

export const appliedLine = (count: number, added: string[]) =>
  `applied ${plural(count, 'op')}${added.length ? ` · added ${added.join(' ')}` : ''}`;

function sessionOf(ctx: OutlineCtx): string {
  if (!ctx.session) throw new InputError('outline needs --session <id>, or run it from Claude Code');
  return ctx.session;
}

const route = (ctx: OutlineCtx, file?: string) =>
  `/sessions/${encodeURIComponent(sessionOf(ctx))}/outline${file === undefined ? '' : `?path=${encodeURIComponent(file)}`}`;

function outlinePath(raw: string | undefined, verb: string): string {
  if (!raw) throw new InputError(`outline ${verb} needs a project-relative <name>.outline.md path`);
  if (!isOutlinePath(raw)) throw new InputError(`${raw} is not an outline. Outline files end in .outline.md`);
  return raw;
}

/** Validates ops before any call, so a bad file exits 2 and changes nothing. */
function cleanOps(raw: unknown): OutlineOp[] {
  try {
    return cleanOutlineOps(raw);
  } catch (e) {
    throw e instanceof OutlineOpError ? new InputError(e.message) : e;
  }
}

async function readOps(ctx: OutlineCtx): Promise<OutlineOp[]> {
  const file = ctx.flag('ops');
  if (!file) throw new InputError('outline apply needs --ops <file.json>, or --ops - for stdin');
  const text = file === '-' ? await ctx.stdin() : await readFile(path.resolve(ctx.cwd, file), 'utf8');
  if (text.trim() === '') throw new InputError(`${file === '-' ? 'stdin' : file} is empty`);
  try {
    return cleanOps(JSON.parse(text));
  } catch (e) {
    throw e instanceof SyntaxError ? new InputError(`--ops is not JSON: ${e.message}`) : e;
  }
}

const readDoc = (ctx: OutlineCtx, file: string) => callJson<OutlineDocument>(ctx.socket, 'GET', route(ctx, file));

/** Applies the ops to the outline as it stands. They target ids, so no version is needed. */
const write = (ctx: OutlineCtx, file: string, ops: OutlineOp[]) => callJson<OutlineUpdateResult>(ctx.socket, 'POST', route(ctx, file), { ops });

type Verb = (ctx: OutlineCtx, words: string[]) => Promise<void>;

const show = <T>(ctx: OutlineCtx, data: T, text: (d: T) => string) => ctx.out(ctx.has('json') ? JSON.stringify(data) : text(data));

export const OUTLINE_VERBS: Record<string, Verb> = {
  async list(ctx) {
    show(ctx, await callJson<OutlineProject>(ctx.socket, 'GET', `${route(ctx)}/project`), formatOutlineProject);
  },

  async new(ctx, words) {
    const title = words.join(' ').trim();
    if (!title) throw new InputError('outline new needs a title');
    const target = ctx.flag('target');
    const kind = ctx.flag('kind');
    if (kind !== undefined && kind !== 'document' && kind !== 'page') throw new InputError(`--kind is document or page, got "${kind}"`);
    const ops = cleanOps([{ op: 'setMeta', title, ...(target ? { target } : {}), ...(kind ? { kind: kind as OutlineKind } : {}) }]);
    const raw = ctx.flag('path');
    const file = raw !== undefined ? outlinePath(raw, 'new') : target ? outlinePathFor(target) : outlineSlugPath(title);

    let res: OutlineUpdateResult;
    try {
      res = await callJson<OutlineUpdateResult>(ctx.socket, 'POST', route(ctx, file), { version: 'missing', ops });
    } catch (e) {
      if (e instanceof ApiError && e.code === 'conflict') {
        throw new ApiError('conflict', `${file} already exists. Run "agent-brief outline show ${file}", or pass --path for a new file`);
      }
      throw e;
    }

    // The file stands even when the panel cannot show it.
    let opened = 'not opened (--no-open)';
    if (!ctx.has('no-open')) {
      const body: OpenRequest = { sessionId: sessionOf(ctx), output: { path: file } };
      opened = await callJson<OpenResponse>(ctx.socket, 'POST', '/open', body).then(
        () => 'opened in Write',
        (e) => {
          if (e instanceof ApiError) return `not opened: ${e.message}`;
          throw e;
        },
      );
    }
    show(ctx, res, (r) => `${r.path}\nmade "${r.title}"${r.target ? ` for ${r.target}` : ''} · ${opened}`);
  },

  async show(ctx, [raw]) {
    show(ctx, await readDoc(ctx, outlinePath(raw, 'show')), formatOutline);
  },

  async apply(ctx, [raw]) {
    const file = outlinePath(raw, 'apply');
    const ops = await readOps(ctx);
    const res = await write(ctx, file, ops);
    show(ctx, res, (r) => appliedLine(ops.length, r.added));
  },
};

export async function runOutline(ctx: OutlineCtx): Promise<void> {
  const [verb, ...words] = ctx.positional;
  const run = verb ? OUTLINE_VERBS[verb] : undefined;
  if (!run) throw new InputError(`outline takes ${Object.keys(OUTLINE_VERBS).join(', ')}. Run "agent-brief outline --help".`);
  await run(ctx, words);
}
