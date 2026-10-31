/** Both panel and agent writes go through this synchronous, revision-checked store. */
import { existsSync, lstatSync, realpathSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import type { BehaviorDecision, BehaviorDocument, BehaviorRule, BehaviorSpec, BehaviorUpdate } from '../protocol';
import { behaviorPath, parseBehavior, validLimitations, validRules } from '../shared/behavior';
import { plainRelative, within } from './feedback-paths';
import { hash, readCapped, writeAtomic } from './files';
import { BoardError, badRequest } from '../board/errors';

const bad = (s: string): never => { throw badRequest(s); };
const MAX_BYTES = 8 * 1024 * 1024;

export class BehaviorStore {
  /** `changed` gets the project and the specification the store wrote. */
  constructor(private readonly changed: (root: string, path: string) => void = () => {}) {}

  private file(root: string, html: unknown): { file: string; path: string } {
    if (typeof html !== 'string' || !/\.html?$/i.test(html) || !plainRelative(html)) return bad('Expected a project-relative HTML path without dot folders');
    const realRoot = realpathSync(root);
    const target = resolve(realRoot, html);
    if (!within(realRoot, target) || !existsSync(target) || !within(realRoot, realpathSync(target)) || !statSync(target).isFile()) return bad('Prototype must be a file inside the project');
    // Resolve the prototype first, so aliases share one specification.
    const file = behaviorPath(realpathSync(target));
    if (existsSync(file) && (lstatSync(file).isSymbolicLink() || !statSync(file).isFile())) return bad('Behavior specification must be a regular file');
    return { file, path: relative(realRoot, file) };
  }

  read(root: string, html: unknown): BehaviorDocument {
    const { file, path } = this.file(root, html);
    const text = readCapped(file, path, MAX_BYTES);
    if (text === undefined) return { schema: 1, revision: 0, rules: [], limitations: [], history: [], path, version: 'missing' };
    try { return { ...parseBehavior(text), path, version: hash(text) }; }
    catch { return bad(`Invalid behavior specification in ${path}; repair it before saving`); }
  }

  update(root: string, html: unknown, raw: unknown, by: string): BehaviorDocument {
    const req = raw as BehaviorUpdate | undefined;
    if (!req || typeof req.version !== 'string' || (req.upsert !== undefined && !validRules(req.upsert)) || (req.limitations !== undefined && !validLimitations(req.limitations)) || (!req.upsert && !req.limitations)) return bad('Expected version and upsert rules or limitations');
    const doc = this.read(root, html);
    this.check(doc, req.version);
    const rules = [...doc.rules];
    for (const incoming of req.upsert ?? []) {
      const index = rules.findIndex((r) => r.id === incoming.id);
      const old = rules[index];
      let next = structuredClone(incoming);
      if (old) {
        const changed = old.text !== next.text || JSON.stringify(old.target) !== JSON.stringify(next.target);
        // An agent cannot retain or create a confirmation while changing an existing rule.
        // A new explicit requirement may be confirmed with its source; proposals need a PM decision.
        if (changed || old.status === 'proposed') {
          next = { ...next, status: 'proposed', delivery: 'planned' };
          delete next.evidence;
        } else {
          next.status = old.status;
          next.source = old.source;
        }
        rules[index] = next;
      } else rules.push(next);
    }
    if (!validRules(rules)) return bad('Too many rules or invalid behavior update');
    return this.save(root, html, doc, rules, req.limitations ?? doc.limitations, by);
  }

  decide(root: string, html: unknown, raw: unknown): BehaviorDocument {
    const req = raw as BehaviorDecision | undefined;
    if (!req || typeof req.version !== 'string' || typeof req.id !== 'string' || typeof req.text !== 'string' || !req.text.trim() || req.text.length > 4000 || !['proposed', 'confirmed'].includes(req.status) || (req.note !== undefined && (typeof req.note !== 'string' || req.note.length > 4000))) return bad('Invalid behavior decision');
    const doc = this.read(root, html);
    this.check(doc, req.version);
    const old = doc.rules.find((r) => r.id === req.id);
    if (!old) return bad('That rule no longer exists; refresh Behavior');
    const changed = old.text !== req.text.trim() || old.status !== req.status;
    const next: BehaviorRule = { ...old, text: req.text.trim(), status: req.status, note: req.note ?? old.note,
      source: req.status === 'confirmed' ? { kind: 'decision', ref: `PM decision in ${doc.path}, revision ${doc.revision + 1}` } : old.source,
      delivery: changed ? 'planned' : old.delivery };
    if (changed) delete next.evidence;
    return this.save(root, html, doc, doc.rules.map((r) => r.id === req.id ? next : r), doc.limitations, 'PM');
  }

  private check(doc: BehaviorDocument, version: string): void {
    if (doc.version !== version) throw new BoardError('conflict', 'Behavior changed since you read it. Refresh, review the changes, and save again. Your edit has not been applied.');
  }

  private save(root: string, html: unknown, doc: BehaviorDocument, rules: BehaviorRule[], limitations: string[], by: string): BehaviorDocument {
    if (JSON.stringify(rules) === JSON.stringify(doc.rules) && JSON.stringify(limitations) === JSON.stringify(doc.limitations)) return doc;
    const revision = doc.revision + 1;
    const spec: BehaviorSpec = { schema: 1, revision, rules, limitations, history: [...doc.history, { revision, at: new Date().toISOString(), by, before: doc.rules, after: rules, limitationsBefore: doc.limitations, limitationsAfter: limitations }].slice(-100) };
    const text = JSON.stringify(spec, null, 2) + '\n';
    if (Buffer.byteLength(text) > MAX_BYTES) return bad('Behavior history exceeds 8 MB');
    const { file } = this.file(root, html);
    this.check(this.read(root, html), doc.version);
    writeAtomic(file, text);
    this.changed(root, doc.path);
    return { ...spec, path: doc.path, version: hash(text) };
  }
}
