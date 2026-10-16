/**
 * Files in a session's project: the items file, the outputs the mod records, and opening
 * either one. Items are watched for live tracked sessions, outputs for every live session with a brief.
 */

import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import { outputsFile } from '../protocol';
import { itemsFile } from '../server/index';
import { newDraftId } from '../shared/drafts';
import { CH, type Decision, type ItemsDocInfo, type OutputsInfo } from '../shared/ipc';
import { decisionsDraft, parseItems, withDecisions } from '../shared/items';
import { isUrlRef, outputTouchedAt, parseOutputsFile, sortOutputs } from '../shared/outputs';
import { isReviewable } from '../shared/review';
import { cleanEdit, type EditResult, type HistoryResult } from '../shared/review-edit';
import type { Briefs } from './briefs';
import { MAX_DRAFT_BODY, type DraftStore } from './drafts';
import { applyEdit, EditError, editableOffsets, versionOf } from './html-edit';
import { ItemsWatcher } from './items-watch';
import { liveFields } from './session-briefs';

/** Opens things outside the app. Tests record them instead. */
export interface Opener {
  openPath(target: string): Promise<void>;
  openExternal(url: string): Promise<void>;
}

export interface SessionFilesDeps {
  briefs: Briefs;
  drafts: DraftStore;
  send: (channel: string, ...args: unknown[]) => void;
  opener: Opener;
  /** The review pane's address for an HTML file in `cwd`. */
  reviewUrlFor: (cwd: string, path: string) => string;
}

const MARKDOWN = new Set(['.md', '.markdown', '.mdx']);
/** Undo steps kept per file. */
const MAX_UNDO = 100;

/** One edit's file text on both sides, for undo and redo. */
interface Step {
  before: string;
  after: string;
  summary: string;
}
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

const readOrUndefined = (path: string): string | undefined => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
};

/** An http or https URL, else an error. */
export function webUrl(raw: string, invalid: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(invalid);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Agent Brief opens only http and https links');
  return url;
}

export class SessionFiles {
  private readonly itemsWatch: ItemsWatcher;
  private readonly outputsWatch: ItemsWatcher;

  constructor(private readonly deps: SessionFilesDeps) {
    this.itemsWatch = new ItemsWatcher((sessionId) => {
      const info = this.items(sessionId);
      if (info) deps.send(CH.items, info);
    });
    this.outputsWatch = new ItemsWatcher((sessionId) => this.pushOutputs(sessionId));
  }

  /** Watches exactly the sessions the briefs call for. */
  sync(): void {
    const { briefs } = this.deps;
    const items = new Map<string, string>();
    const outputs = new Map<string, string>();
    for (const [id, b] of Object.entries(briefs.all())) {
      // Only a live session's Claude writes these files. The panel reads an ended one's when it opens.
      if (!briefs.live(id)) continue;
      const itemsPath = b.trackItems ? this.itemsPath(id) : undefined;
      const outputsPath = this.outputsPath(id);
      if (itemsPath) items.set(id, itemsPath);
      if (outputsPath) outputs.set(id, outputsPath);
    }
    this.itemsWatch.sync(items);
    this.outputsWatch.sync(outputs);
  }

  close(): void {
    this.itemsWatch.close();
    this.outputsWatch.close();
  }

  items(sessionId: string): ItemsDocInfo | undefined {
    const path = this.itemsPath(sessionId);
    if (!path) return undefined;
    const text = readOrUndefined(path);
    return { sessionId, path, exists: text !== undefined, doc: parseItems(text ?? '') };
  }

  /** Appends the decisions to the items file and returns the prompt that reports them. */
  saveDecisions(sessionId: string, raw: unknown): { draft: string } {
    const cwd = this.cwd(sessionId);
    const path = itemsFile(cwd, sessionId);
    if (!existsSync(path)) throw new Error(`Claude has not written ${path} yet`);
    const text = readFileSync(path, 'utf8');
    const doc = parseItems(text);
    const decisions = (Array.isArray(raw) ? raw : []).filter(
      (d): d is Decision =>
        typeof d?.n === 'number' && typeof d?.text === 'string' && d.text.trim() !== '' && doc.items.some((i) => i.n === d.n),
    );
    if (decisions.length === 0) throw new Error('No decision names an item in the file');
    const next = withDecisions(text, decisions);
    if (next !== text) writeFileSync(path, next);
    return { draft: decisionsDraft(relative(cwd, path), decisions, doc) };
  }

  /** The session's outputs, with the ones the user hid left out. */
  outputs(sessionId: string): OutputsInfo | undefined {
    const path = this.outputsPath(sessionId);
    if (!path) return undefined;
    const text = readOrUndefined(path);
    const dismissed = this.deps.briefs.get(sessionId)?.dismissedOutputs ?? {};
    const hidden = (ref: string, touched: number) => Object.hasOwn(dismissed, ref) && touched <= dismissed[ref];
    const records = (text === undefined ? undefined : parseOutputsFile(text))?.outputs ?? [];
    return {
      sessionId,
      path,
      exists: text !== undefined,
      outputs: sortOutputs(records.filter((r) => !hidden(r.ref, outputTouchedAt(r)))),
    };
  }

  /**
   * Hides an output until the file records a later write or declaration for it.
   * Keeps the brief's place, and forgets dismissals for refs the file no longer lists.
   */
  dismissOutput(sessionId: string, ref: unknown): void {
    const { briefs } = this.deps;
    if (typeof ref !== 'string' || ref === '') throw new Error('No output named');
    const path = this.outputsPath(sessionId);
    if (!path) throw new Error(`Agent Brief does not know session ${sessionId}`);
    const text = readOrUndefined(path);
    if (text === undefined) throw new Error(`Agent Brief has no outputs for session ${sessionId}`);
    const records = parseOutputsFile(text)?.outputs ?? [];
    const record = records.find((r) => r.ref === ref);
    if (!record) throw new Error(`${ref} is not among the session's outputs`);
    const prev = briefs.get(sessionId);
    const kept = Object.entries(prev?.dismissedOutputs ?? {}).filter(([r]) => records.some((x) => x.ref === r));
    const dismissedOutputs = { ...Object.fromEntries(kept), [ref]: outputTouchedAt(record) };
    const live = briefs.live(sessionId);
    briefs.keepPlace(sessionId, { dismissedOutputs, ...(live ? liveFields(live) : {}) });
    if (!prev) briefs.publish();
    this.pushOutputs(sessionId);
  }

  /**
   * Opens an output. A link opens in the browser. An HTML file opens in the review pane.
   * A Markdown file opens in Write mode as a note filed under the session, reusing the note
   * already open on that file. Any other file opens in its default app.
   */
  async openOutput(sessionId: string, ref: unknown): Promise<void> {
    const { briefs, drafts, opener } = this.deps;
    if (typeof ref !== 'string' || ref.trim() === '') throw new Error('No output named');
    if (isUrlRef(ref)) {
      await opener.openExternal(webUrl(ref, `${ref} is not a valid link`).href);
      return;
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(ref)) throw new Error('Agent Brief opens only http and https links');
    const { target } = this.projectFile(sessionId, ref);
    if (isReviewable(target)) {
      this.openReview(sessionId, ref);
      return;
    }
    if (!MARKDOWN.has(extname(target).toLowerCase())) {
      await opener.openPath(target);
      return;
    }
    const existing = drafts.list().find((d) => d.sessionId === sessionId && d.source?.path === ref);
    if (existing) {
      briefs.showDraft(sessionId, existing.id, false);
      return;
    }
    if (statSync(target).size > MAX_OUTPUT_BYTES) throw new Error(`${ref} is over 4 MB, too large to open as a note`);
    const text = readFileSync(target, 'utf8');
    if (text.length > MAX_DRAFT_BODY) throw new Error(`${ref} is longer than a note can hold (${MAX_DRAFT_BODY.toLocaleString('en-US')} characters)`);
    briefs.startNote({ text, id: newDraftId(), sessionId, source: { path: ref } }, false);
  }

  /** Opens a project file in its default app. */
  async openElsewhere(sessionId: string, path: unknown): Promise<void> {
    await this.deps.opener.openPath(this.projectFile(sessionId, path).target);
  }

  /** The address the review pane loads, after the same checks as opening the file. */
  reviewUrl(sessionId: string, path: unknown): string {
    const { cwd } = this.projectFile(sessionId, path);
    if (!isReviewable(String(path))) throw new Error(`${String(path)} is not an HTML file`);
    return this.deps.reviewUrlFor(cwd, String(path).trim());
  }

  /** Applies one review pane edit to an HTML file, unless the file changed since the page loaded. */
  reviewEdit(sessionId: string, path: unknown, version: unknown, raw: unknown): EditResult {
    const edit = cleanEdit(raw);
    if (!edit) return { ok: false, error: 'That edit is not one the pane makes' };
    const target = this.reviewTarget(sessionId, path);
    const text = readFileSync(target, 'utf8');
    if (versionOf(text) !== version) return { ok: false, error: 'The file changed since the page loaded. Reloading it.', stale: true };
    try {
      const applied = applyEdit(text, edit);
      if (applied.html !== text) {
        writeFileSync(target, applied.html);
        const steps = this.steps(target);
        steps.undo.push({ before: text, after: applied.html, summary: applied.summary });
        if (steps.undo.length > MAX_UNDO) steps.undo.shift();
        steps.redo.length = 0;
      }
      return {
        ok: true,
        version: versionOf(applied.html),
        offsets: editableOffsets(applied.html),
        ...(applied.at === undefined ? {} : { at: applied.at }),
        summary: applied.summary,
      };
    } catch (err) {
      if (err instanceof EditError) return { ok: false, error: err.message };
      throw err;
    }
  }

  /** Puts back the file as it was before the last pane edit. */
  reviewUndo(sessionId: string, path: unknown): HistoryResult {
    return this.step(sessionId, path, 'undo');
  }

  reviewRedo(sessionId: string, path: unknown): HistoryResult {
    return this.step(sessionId, path, 'redo');
  }

  private readonly history = new Map<string, { undo: Step[]; redo: Step[] }>();

  private steps(target: string) {
    let steps = this.history.get(target);
    if (!steps) this.history.set(target, (steps = { undo: [], redo: [] }));
    return steps;
  }

  private step(sessionId: string, path: unknown, way: 'undo' | 'redo'): HistoryResult {
    const target = this.reviewTarget(sessionId, path);
    const steps = this.steps(target);
    const step = steps[way].at(-1);
    if (!step) return { ok: false, error: way === 'undo' ? 'Nothing to undo' : 'Nothing to redo' };
    const text = readFileSync(target, 'utf8');
    const [from, to] = way === 'undo' ? [step.after, step.before] : [step.before, step.after];
    // A change made outside the pane since the edit, such as Claude's, is never written over.
    if (text !== from) {
      steps.undo.length = 0;
      steps.redo.length = 0;
      return { ok: false, error: 'The file changed outside the pane, so its edit history is gone' };
    }
    writeFileSync(target, to);
    steps[way].pop();
    steps[way === 'undo' ? 'redo' : 'undo'].push(step);
    return { ok: true, summary: `${way === 'undo' ? 'Undid' : 'Redid'}: ${step.summary}` };
  }

  private reviewTarget(sessionId: string, path: unknown): string {
    const { target } = this.projectFile(sessionId, path);
    if (!isReviewable(String(path))) throw new Error(`${String(path)} is not an HTML file`);
    return target;
  }

  /** Opens an HTML output in the review pane, reusing the review already open on that file. */
  private openReview(sessionId: string, ref: string): void {
    const { briefs, drafts } = this.deps;
    const existing = drafts.list().find((d) => d.sessionId === sessionId && d.review?.path === ref);
    if (existing) briefs.showDraft(sessionId, existing.id, false);
    else briefs.startNote({ id: newDraftId(), sessionId, review: { path: ref, comments: [] } }, false);
  }

  private pushOutputs(sessionId: string): void {
    const info = this.outputs(sessionId);
    if (info) this.deps.send(CH.outputs, info);
  }

  private cwd(sessionId: string): string {
    const cwd = this.deps.briefs.cwdOf(sessionId);
    if (!cwd) throw new Error(`Agent Brief does not know session ${sessionId}`);
    return cwd;
  }

  private itemsPath(sessionId: string): string | undefined {
    const cwd = this.deps.briefs.cwdOf(sessionId);
    return cwd ? itemsFile(cwd, sessionId) : undefined;
  }

  private outputsPath(sessionId: string): string | undefined {
    const cwd = this.deps.briefs.cwdOf(sessionId);
    return cwd ? outputsFile(cwd, sessionId) : undefined;
  }

  /**
   * Resolves a path Claude named against the session's folder. Only an existing file
   * inside the folder resolves, symlinks included.
   */
  private projectFile(sessionId: string, path: unknown): { cwd: string; target: string } {
    const cwd = this.cwd(sessionId);
    if (typeof path !== 'string' || path.trim() === '') throw new Error('No file named');
    const target = resolve(cwd, path.trim());
    const within = (root: string, p: string) => {
      const rel = relative(root, p);
      return rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel);
    };
    if (!within(cwd, target)) throw new Error(`${path} is outside the project`);
    if (!existsSync(target)) throw new Error(`${path} does not exist yet`);
    if (!within(realpathSync(cwd), realpathSync(target))) throw new Error(`${path} is outside the project`);
    return { cwd, target };
  }
}
