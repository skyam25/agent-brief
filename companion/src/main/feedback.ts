/** Panel and agent writes to feedback files go through this synchronous, version-checked store. */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { relative } from 'node:path';
import type { FeedbackDocument, FeedbackProject, FeedbackRound, FeedbackUpdate, FeedbackUpdateResult } from '../protocol';
import { buildFeedbackGraph, type GraphFile } from '../shared/feedback-graph';
import { applyFeedbackOps, FEEDBACK_SUFFIX, feedbackSummary, FeedbackOpError, isoDate, parseFeedback, type FeedbackActor } from '../shared/feedback';
import { resolveFeedback } from './feedback-paths';
import { checkVersion, fileVersion, readCapped, scanProject, writeAtomic } from './files';
import { badRequest } from '../board/errors';

const bad = (s: string): never => { throw badRequest(s); };
const MAX_BYTES = 4 * 1024 * 1024;
const isFeedbackFile = (name: string) => name.endsWith(FEEDBACK_SUFFIX) && name !== FEEDBACK_SUFFIX;

export class FeedbackStore {
  /** `changed` gets the project and the output whose feedback file the store wrote. */
  constructor(private readonly changed: (root: string, output: string) => void = () => {}, private readonly now: () => Date = () => new Date()) {}

  /** With `orphan`, a feedback file whose output is gone reads too. Writes always need the output. */
  read(root: string, output: unknown, opts: { orphan?: boolean } = {}): FeedbackDocument {
    const where = resolveFeedback(root, output, opts);
    const text = readCapped(where.file, where.path, MAX_BYTES);
    const gone = where.outputExists ? {} : { outputExists: false as const };
    if (text === undefined) return { title: '', rounds: [], items: [], path: where.path, output: where.output, version: 'missing', ...gone };
    return { ...parseFeedback(text), path: where.path, output: where.output, version: fileVersion(text), ...gone };
  }

  update(root: string, output: unknown, raw: unknown, by: FeedbackActor): FeedbackUpdateResult {
    const req = raw as FeedbackUpdate | undefined;
    if (!req || typeof req !== 'object' || (req.version !== undefined && typeof req.version !== 'string') || !Array.isArray(req.ops)) return bad('Expected ops, and an optional version');
    const where = resolveFeedback(root, output);
    const before = readCapped(where.file, where.path, MAX_BYTES);
    checkVersion(before, req.version, 'Feedback');
    // Round numbers are project-wide, so a new round looks at every feedback file.
    const projectRounds = req.ops.some((op) => op?.op === 'addRound') ? this.projectRounds(root) : undefined;
    let next: ReturnType<typeof applyFeedbackOps>;
    try { next = applyFeedbackOps(before, { output: where.output, ops: req.ops, by, date: isoDate(this.now()), projectRounds }); }
    catch (err) {
      if (err instanceof FeedbackOpError) return bad(err.message);
      throw err;
    }
    if (Buffer.byteLength(next.text) > MAX_BYTES) return bad(`${where.path} would exceed 4 MB`);
    if (next.text !== before) {
      writeAtomic(where.file, next.text);
      this.changed(root, where.output);
    }
    return { ...parseFeedback(next.text), path: where.path, output: where.output, version: fileVersion(next.text), added: next.added };
  }

  /** Every feedback file under the project, skipping dot folders and node_modules, and the graph that links them. */
  project(root: string): FeedbackProject {
    const realRoot = realpathSync(root);
    const { found, truncated } = scanProject(realRoot, isFeedbackFile, MAX_BYTES);
    const parsed: GraphFile[] = found.map((full) => {
      const outputFull = full.slice(0, -FEEDBACK_SUFFIX.length);
      return { path: relative(realRoot, full), output: relative(realRoot, outputFull), outputExists: existsSync(outputFull), doc: parseFeedback(readFileSync(full, 'utf8')) };
    });
    const files = parsed.map((f) => feedbackSummary(f.path, f.output, f.outputExists, f.doc));
    return { files, graph: buildFeedbackGraph(parsed), ...(truncated ? { truncated } : {}) };
  }

  private projectRounds(root: string): FeedbackRound[] {
    return scanProject(realpathSync(root), isFeedbackFile, MAX_BYTES).found.flatMap((full) => parseFeedback(readFileSync(full, 'utf8')).rounds);
  }
}
