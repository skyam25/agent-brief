/** Panel and agent writes to feedback files go through this synchronous, version-checked store. */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { FeedbackDocument, FeedbackFileSummary, FeedbackProject, FeedbackUpdate, FeedbackUpdateResult } from '../protocol';
import { buildFeedbackGraph, type GraphFile } from '../shared/feedback-graph';
import { applyFeedbackOps, FEEDBACK_SUFFIX, feedbackSummary, FeedbackOpError, isoDate, parseFeedback, type FeedbackActor } from '../shared/feedback';
import { resolveFeedback } from './feedback-paths';

class FeedbackError extends Error {
  constructor(readonly code: 'bad_request' | 'conflict', message: string) { super(message); }
}
const bad = (s: string): never => { throw new FeedbackError('bad_request', s); };
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const MAX_BYTES = 4 * 1024 * 1024;
/** The project scan stops at these. */
const MAX_FILES = 200;
const MAX_DIRS = 5000;

export class FeedbackStore {
  constructor(private readonly changed: () => void = () => {}, private readonly now: () => Date = () => new Date()) {}

  private text(file: string, path: string): string | undefined {
    if (!existsSync(file)) return undefined;
    if (statSync(file).size > MAX_BYTES) return bad(`${path} exceeds 4 MB`);
    return readFileSync(file, 'utf8');
  }

  /** With `orphan`, a feedback file whose output is gone reads too. Writes always need the output. */
  read(root: string, output: unknown, opts: { orphan?: boolean } = {}): FeedbackDocument {
    const where = resolveFeedback(root, output, opts);
    const text = this.text(where.file, where.path);
    const gone = where.outputExists ? {} : { outputExists: false as const };
    if (text === undefined) return { title: '', rounds: [], items: [], path: where.path, output: where.output, version: 'missing', ...gone };
    return { ...parseFeedback(text), path: where.path, output: where.output, version: hash(text), ...gone };
  }

  update(root: string, output: unknown, raw: unknown, by: FeedbackActor): FeedbackUpdateResult {
    const req = raw as FeedbackUpdate | undefined;
    if (!req || typeof req !== 'object' || typeof req.version !== 'string' || !Array.isArray(req.ops)) return bad('Expected version and ops');
    const where = resolveFeedback(root, output);
    const before = this.text(where.file, where.path);
    if ((before === undefined ? 'missing' : hash(before)) !== req.version) throw new FeedbackError('conflict', 'Feedback changed since you read it. Read it again and retry. Nothing was written.');
    let next: ReturnType<typeof applyFeedbackOps>;
    try { next = applyFeedbackOps(before, { output: where.output, ops: req.ops, by, date: isoDate(this.now()) }); }
    catch (err) {
      if (err instanceof FeedbackOpError) return bad(err.message);
      throw err;
    }
    if (Buffer.byteLength(next.text) > MAX_BYTES) return bad(`${where.path} would exceed 4 MB`);
    if (next.text !== before) {
      const tmp = `${where.file}.${randomUUID()}.tmp`;
      try { writeFileSync(tmp, next.text, { flag: 'wx' }); renameSync(tmp, where.file); }
      finally { if (existsSync(tmp)) unlinkSync(tmp); }
      this.changed();
    }
    return { ...parseFeedback(next.text), path: where.path, output: where.output, version: hash(next.text), added: next.added };
  }

  /** Every feedback file under the project, skipping dot folders and node_modules, and the graph that links them. */
  project(root: string): FeedbackProject {
    const realRoot = realpathSync(root);
    const files: FeedbackFileSummary[] = [];
    const parsed: GraphFile[] = [];
    const queue = [realRoot];
    let dirs = 0;
    let truncated = false;
    while (queue.length) {
      if (++dirs > MAX_DIRS) { truncated = true; break; }
      const dir = queue.shift()!;
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (e.name.startsWith('.') || e.name === 'node_modules') continue;
        const full = join(dir, e.name);
        if (e.isDirectory()) queue.push(full);
        else if (e.isFile() && e.name.endsWith(FEEDBACK_SUFFIX) && e.name !== FEEDBACK_SUFFIX) {
          if (files.length >= MAX_FILES) { truncated = true; break; }
          if (statSync(full).size > MAX_BYTES) continue;
          const outputFull = full.slice(0, -FEEDBACK_SUFFIX.length);
          const file: GraphFile = { path: relative(realRoot, full), output: relative(realRoot, outputFull), outputExists: existsSync(outputFull), doc: parseFeedback(readFileSync(full, 'utf8')) };
          parsed.push(file);
          files.push(feedbackSummary(file.path, file.output, file.outputExists, file.doc));
        }
      }
      if (files.length >= MAX_FILES && truncated) break;
    }
    return { files, graph: buildFeedbackGraph(parsed), ...(truncated ? { truncated } : {}) };
  }
}
