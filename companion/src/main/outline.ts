/** Panel and agent writes to outline files go through this synchronous, version-checked store. */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import type { OutlineDoc, OutlineDocument, OutlineOp, OutlineProject, OutlineUpdate, OutlineUpdateResult } from '../protocol';
import { isoDate } from '../shared/feedback';
import type { OutlineCreate } from '../shared/ipc';
import { isBlankOutline, outlineRowChanges, type OutlineChanges } from '../shared/outline-changes';
import { applyOutlineOps, isOutlinePath, OUTLINE_SUFFIX, OutlineOpError, outlinePathFor, outlineSlugPath, outlineSummary, parseOutline } from '../shared/outline';
import { plainRelative, within } from './feedback-paths';

class OutlineError extends Error {
  constructor(readonly code: 'bad_request' | 'conflict', message: string) { super(message); }
}
const bad = (s: string): never => { throw new OutlineError('bad_request', s); };
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const MAX_BYTES = 4 * 1024 * 1024;
/** The project scan stops at these. */
const MAX_FILES = 200;
const MAX_DIRS = 5000;

const lstatOrUndefined = (p: string) => { try { return lstatSync(p); } catch { return undefined; } };

interface OutlineFile {
  realRoot: string;
  /** The outline, absolute and canonical. */
  file: string;
  /** The outline, project-relative. */
  path: string;
}

/**
 * An outline path inside the project. The file need not exist, and neither need its folders.
 * Checks run on the canonical path of the nearest folder that does, so a symlink cannot reach outside.
 */
function resolveOutline(root: string, path: unknown): OutlineFile {
  if (typeof path !== 'string' || !plainRelative(path)) return bad('Expected a project-relative outline path without dot folders or control characters');
  if (!isOutlinePath(path)) return bad(`An outline path ends with ${OUTLINE_SUFFIX}`);
  const realRoot = realpathSync(root);
  const target = resolve(realRoot, path);
  if (!within(realRoot, target)) return bad('Outline must be inside the project');
  let dir = dirname(target);
  const rest = [basename(target)];
  while (!existsSync(dir)) {
    rest.unshift(basename(dir));
    dir = dirname(dir);
  }
  const realDir = realpathSync(dir);
  if (!statSync(realDir).isDirectory()) return bad(`${relative(realRoot, realDir)} is not a folder`);
  const file = join(realDir, ...rest);
  const rel = relative(realRoot, file);
  if (!within(realRoot, file) || !plainRelative(rel)) return bad('Outline must be inside the project, outside dot folders');
  const there = lstatOrUndefined(file);
  if (there && (there.isSymbolicLink() || !there.isFile())) return bad('Outline must be a regular file');
  return { realRoot, file, path: rel };
}

const EMPTY: OutlineDoc = { title: '', kind: 'document', intent: [], sections: [], sources: [] };

/** Who wrote: the panel's user, or Claude through the socket. */
export type OutlineAuthor = 'you' | 'claude';

/**
 * The outline as it stood before Claude's first unreviewed change, and the rows you edited since,
 * which no longer count as Claude's. Kept per outline until you mark the changes reviewed.
 */
interface ChangeRecord {
  baseline: string;
  touched: string[];
  /** Ids Claude gave to new rows after removing the baseline's rows of that id. */
  reused?: string[];
  /** ISO time of Claude's latest change. */
  at: string;
}

/** The ids of a doc's sections, points and sources. */
const rowIds = (doc: OutlineDoc) => [...doc.sections.flatMap((s) => [s.id, ...s.points.map((p) => p.id)]), ...doc.sources.map((s) => s.id)];

/** Whether the target is on disk, when the outline names one inside the project. */
function targetState(realRoot: string, doc: OutlineDoc): { targetExists?: boolean } {
  if (!doc.target) return {};
  const target = resolve(realRoot, doc.target);
  return { targetExists: within(realRoot, target) && existsSync(target) };
}

export class OutlineStore {
  constructor(
    private readonly changed: (root: string, path: string) => void = () => {},
    private readonly now: () => Date = () => new Date(),
    /** Where change records live. Without it, changes are not tracked. */
    private readonly changesDir?: string,
  ) {}

  private recordFile(where: OutlineFile): string | undefined {
    return this.changesDir && join(this.changesDir, `${hash(`${where.realRoot}\n${where.path}`).slice(0, 32)}.json`);
  }

  private record(where: OutlineFile): ChangeRecord | undefined {
    const file = this.recordFile(where);
    if (!file || !existsSync(file)) return undefined;
    try {
      const r = JSON.parse(readFileSync(file, 'utf8')) as Partial<ChangeRecord>;
      if (typeof r.baseline !== 'string' || !Array.isArray(r.touched) || typeof r.at !== 'string') return undefined;
      const strings = (list: unknown) => (Array.isArray(list) ? list.filter((t): t is string => typeof t === 'string') : []);
      return { baseline: r.baseline, touched: strings(r.touched), reused: strings(r.reused), at: r.at };
    } catch {
      return undefined;
    }
  }

  private saveRecord(where: OutlineFile, record: ChangeRecord | undefined): void {
    const file = this.recordFile(where);
    if (!file) return;
    if (!record) {
      if (existsSync(file)) unlinkSync(file);
      return;
    }
    mkdirSync(this.changesDir!, { recursive: true });
    writeFileSync(file, JSON.stringify(record));
  }

  /**
   * Claude's first change keeps the outline as it was, unless it was blank, since a first draft is all new.
   * A later change of Claude's counts again on rows you had touched. A change of yours takes its rows off the list.
   */
  private track(where: OutlineFile, before: string | undefined, after: OutlineDoc, added: string[], by: OutlineAuthor): void {
    const old = before === undefined ? EMPTY : parseOutline(before);
    const ids = outlineRowChanges(old, after).map((c) => c.id);
    if (!ids.length) return;
    const record = this.record(where);
    if (by === 'you') {
      if (record) this.saveRecord(where, { ...record, touched: [...new Set([...record.touched, ...ids])] });
      return;
    }
    const at = this.now().toISOString();
    const baseline = record?.baseline ?? before;
    if (baseline === undefined || (!record && isBlankOutline(old))) return;
    const had = new Set(rowIds(parseOutline(baseline)));
    const reused = [...new Set([...(record?.reused ?? []), ...added.filter((id) => had.has(id))])];
    this.saveRecord(where, { baseline, touched: (record?.touched ?? []).filter((t) => !ids.includes(t)), ...(reused.length ? { reused } : {}), at });
  }

  /** What Claude changed since you last marked the outline reviewed. Undefined when nothing is left to review. */
  changes(root: string, path: unknown): OutlineChanges | undefined {
    const where = resolveOutline(root, path);
    const record = this.record(where);
    if (!record) return undefined;
    const text = this.text(where);
    const current = text === undefined ? EMPTY : parseOutline(text);
    const touched = new Set(record.touched);
    const rows = outlineRowChanges(parseOutline(record.baseline), current, new Set(record.reused)).filter((c) => !touched.has(c.id));
    return rows.length ? { at: record.at, rows } : undefined;
  }

  /** Forgets Claude's changes, so the outline as it stands is what you last saw. */
  markReviewed(root: string, path: unknown): void {
    const where = resolveOutline(root, path);
    if (!this.record(where)) return;
    this.saveRecord(where, undefined);
    this.changed(root, where.path);
  }

  private text(where: OutlineFile): string | undefined {
    if (!existsSync(where.file)) return undefined;
    if (statSync(where.file).size > MAX_BYTES) return bad(`${where.path} exceeds 4 MB`);
    return readFileSync(where.file, 'utf8');
  }

  /** Version `missing` and an empty outline when the file is not there. */
  read(root: string, path: unknown): OutlineDocument {
    const where = resolveOutline(root, path);
    const text = this.text(where);
    const doc = text === undefined ? EMPTY : parseOutline(text);
    return { ...doc, path: where.path, version: text === undefined ? 'missing' : hash(text), ...targetState(where.realRoot, doc) };
  }

  /** Version `missing` creates the file, which then needs a setMeta with a title. */
  update(root: string, path: unknown, raw: unknown, by: OutlineAuthor = 'you'): OutlineUpdateResult {
    const req = raw as OutlineUpdate | undefined;
    if (!req || typeof req !== 'object' || typeof req.version !== 'string' || !Array.isArray(req.ops)) return bad('Expected version and ops');
    const where = resolveOutline(root, path);
    const before = this.text(where);
    if ((before === undefined ? 'missing' : hash(before)) !== req.version) throw new OutlineError('conflict', 'Outline changed since you read it. Read it again and retry. Nothing was written.');
    let next: ReturnType<typeof applyOutlineOps>;
    try { next = applyOutlineOps(before, { ops: req.ops, date: isoDate(this.now()) }); }
    catch (err) {
      if (err instanceof OutlineOpError) return bad(err.message);
      throw err;
    }
    if (Buffer.byteLength(next.text) > MAX_BYTES) return bad(`${where.path} would exceed 4 MB`);
    if (next.text !== before) {
      mkdirSync(dirname(where.file), { recursive: true });
      const tmp = `${where.file}.${randomUUID()}.tmp`;
      try { writeFileSync(tmp, next.text, { flag: 'wx' }); renameSync(tmp, where.file); }
      finally { if (existsSync(tmp)) unlinkSync(tmp); }
      // Change marks are a convenience, so a failure never fails the write.
      try { this.track(where, before, next.doc, next.added, by); } catch {}
      this.changed(root, where.path);
    }
    return { ...next.doc, path: where.path, version: hash(next.text), ...targetState(where.realRoot, next.doc), added: next.added };
  }

  /**
   * Writes a new outline and answers its project-relative path. The path comes from `path`,
   * else from the target, else from the title at the project root. An existing file is refused.
   */
  create(root: string, raw: unknown): string {
    const c = raw as Partial<OutlineCreate> | null;
    if (!c || typeof c !== 'object' || typeof c.title !== 'string' || !c.title.trim()) return bad('An outline needs a title');
    const target = typeof c.target === 'string' && c.target.trim() ? c.target.trim() : undefined;
    const path = typeof c.path === 'string' && c.path.trim() ? c.path.trim() : target ? outlinePathFor(target) : outlineSlugPath(c.title);
    const where = resolveOutline(root, path);
    if (lstatOrUndefined(where.file)) throw new OutlineError('conflict', `${where.path} already exists`);
    const meta: OutlineOp = { op: 'setMeta', title: c.title, ...(target ? { target } : {}), ...(c.kind ? { kind: c.kind } : {}) };
    return this.update(root, where.path, { version: 'missing', ops: [meta] }).path;
  }

  /** Every outline under the project, skipping dot folders and node_modules. */
  project(root: string): OutlineProject {
    const realRoot = realpathSync(root);
    const { found, truncated } = scan(realRoot);
    const files = found.map((full) => outlineSummary(relative(realRoot, full), parseOutline(readFileSync(full, 'utf8'))));
    return { files, ...(truncated ? { truncated } : {}) };
  }
}

/** Outline files under the project, in a stable order, within the scan's limits. */
function scan(realRoot: string): { found: string[]; truncated: boolean } {
  const found: string[] = [];
  const queue = [realRoot];
  let dirs = 0;
  while (queue.length) {
    if (++dirs > MAX_DIRS) return { found, truncated: true };
    const dir = queue.shift()!;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) queue.push(full);
      else if (e.isFile() && isOutlinePath(e.name)) {
        if (found.length >= MAX_FILES) return { found, truncated: true };
        if (statSync(full).size <= MAX_BYTES) found.push(full);
      }
    }
  }
  return { found, truncated: false };
}
