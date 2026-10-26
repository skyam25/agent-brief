/**
 * Outline-first authoring. An outline sits beside the document or page it generates, as `<name>.outline.md`.
 *
 *   # Onboarding memo
 *
 *   Target: docs/memo.md
 *   Kind: document
 *
 *   ## Intent
 *   Reader: VP of Customer Success and the CRO
 *
 *   ## Direction · 2026-10-25 · proposed
 *   Scope: regenerate
 *   - The memo asks leadership to choose among three options
 *   Change: replaced · Intent goal
 *
 *   ## Why change onboarding now ^s1
 *   - New accounts wait a median 6 business days. ^p1
 *       Cite: S1 · wait times · supports
 *   - Open: Can support absorb async Q&A? ^p2
 *       Default: assume no new hire
 *
 *   ## Sources
 *   - S1 · CS ops dashboard export
 *       Ref: data/cs-ops.csv
 *
 * Writers apply id-targeted ops and write the canonical text back. Lines the parser does not
 * recognize stay verbatim on the point, section or source they sit under, or on the doc.
 */

import type { CiteMark, DirectionScope, OutlineCite, OutlineDirection, OutlineDoc, OutlineIntentLine, OutlineKind, OutlineOp, OutlinePoint, OutlineSection, OutlineSource, OutlineSummary } from '../protocol';

export const OUTLINE_SUFFIX = '.outline.md';

const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);

export const isOutlinePath = (path: string) => path.endsWith(OUTLINE_SUFFIX) && baseName(path).length > OUTLINE_SUFFIX.length;

/** `docs/memo.md` → `docs/memo.outline.md`. A name without an extension gets the suffix appended. */
export function outlinePathFor(target: string): string {
  const name = baseName(target);
  const dot = name.lastIndexOf('.');
  return (dot > 0 ? target.slice(0, target.length - name.length + dot) : target) + OUTLINE_SUFFIX;
}

/** `Onboarding memo` → `onboarding-memo.outline.md`. */
export function outlineSlugPath(title: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 60)
    .replace(/^-+|-+$/g, '');
  return `${slug || 'outline'}${OUTLINE_SUFFIX}`;
}

const MARKS: readonly CiteMark[] = ['supports', 'partly', 'not', 'unknown'];
const SCOPES: readonly DirectionScope[] = ['edit', 'sections', 'regenerate'];
const KINDS: readonly OutlineKind[] = ['document', 'page'];

const SEP = ' · ';
const INDENT = '    ';
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SOURCE_ID = /^[A-Za-z][\w-]*$/;
const MAX_TEXT = 4000;
const MAX_OPS = 200;

const SECTION = /^## (.*?)(?:\s+\^(s\d+))?$/;
const POINT = /^- (.*?)(?:\s+\^(p\d+))?$/;
const OPEN = /^Open:\s*(.*)$/;
const DIRECTION = /^## Direction(?:\s*·(.*))?$/;
const INTENT = /^([^:\s#][^:]*?):\s?(.*)$/;
const POINT_KEY = /^(Cite|Guide|Keep|Default):\s?(.*)$/;
const SOURCE_KEY = /^(Ref|Supports|Not shown|Checked):\s?(.*)$/;

const isMark = (s: string): s is CiteMark => (MARKS as readonly string[]).includes(s);

/** `S2 · p.3 · partly · pilot of 12 accounts only`. Parts before the mark are the location, parts after it the note. */
function parseCite(text: string): OutlineCite | undefined {
  const [source = '', ...rest] = text.split(SEP).map((s) => s.trim());
  if (!source) return undefined;
  const at = rest.findIndex(isMark);
  const location = (at < 0 ? rest : rest.slice(0, at)).join(SEP);
  const note = at < 0 ? '' : rest.slice(at + 1).join(SEP);
  return { source, ...(location ? { location } : {}), ...(at >= 0 ? { mark: rest[at] as CiteMark } : {}), ...(note ? { note } : {}) };
}

const citeText = (c: OutlineCite) => [c.source, c.location, c.mark, c.mark ? c.note : undefined].filter(Boolean).join(SEP);

const keep = (owner: { extra?: string[] }, line: string) => (owner.extra ??= []).push(line);

/** Gives every section, point and source an id, numbering the missing and repeated ones after the highest. */
function assignIds(doc: OutlineDoc) {
  const number = (items: { id: string }[], prefix: string) => {
    const own = new RegExp(`^${prefix}(\\d+)$`);
    let max = Math.max(0, ...items.map((i) => Number(own.exec(i.id)?.[1] ?? 0)));
    const seen = new Set<string>();
    for (const item of items) {
      if (!item.id || seen.has(item.id)) item.id = `${prefix}${++max}`;
      seen.add(item.id);
    }
  };
  number(doc.sections, 's');
  number(doc.sections.flatMap((s) => s.points), 'p');
  number(doc.sources, 'S');
}

export function parseOutline(text: string): OutlineDoc {
  const doc: OutlineDoc = { title: '', kind: 'document', intent: [], sections: [], sources: [] };
  let block: 'head' | 'intent' | 'direction' | 'section' | 'sources' = 'head';
  let titled = false;
  let section: OutlineSection | undefined;
  let point: OutlinePoint | undefined;
  let source: OutlineSource | undefined;

  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    const bare = line.trimEnd();
    if (!bare.trim()) continue;

    // Indented lines belong to the point or source above them.
    if (/^\s/.test(line)) {
      const body = bare.trim();
      if (point) {
        const m = POINT_KEY.exec(body);
        const key = m?.[1] as 'Cite' | 'Guide' | 'Keep' | 'Default' | undefined;
        const value = m?.[2]!.trim() ?? '';
        const cite = key === 'Cite' ? parseCite(value) : undefined;
        if (cite) point.cites.push(cite);
        else if (key === 'Guide' && value && point.guide === undefined) point.guide = value;
        else if (key === 'Keep' && value && point.keep === undefined) point.keep = value;
        else if (key === 'Default' && value && point.default === undefined) point.default = value;
        else keep(point, line);
      } else if (source) {
        const m = SOURCE_KEY.exec(body);
        const value = m?.[2]!.trim() ?? '';
        const field = ({ Ref: 'ref', Supports: 'supports', 'Not shown': 'notShown', Checked: 'checked' } as const)[m?.[1] as 'Ref'];
        if (field && value && source[field] === undefined) source[field] = value;
        else keep(source, line);
      } else keep(section ?? doc, line);
      continue;
    }
    point = undefined;
    source = undefined;

    if (bare.startsWith('## ')) {
      const head = SECTION.exec(bare);
      const direction = DIRECTION.exec(bare);
      const special = bare === '## Intent' || bare === '## Sources' || !!direction;
      section = undefined;

      // A heading with an id is always a section, whatever its title.
      if (head && (head[2] || !special)) {
        section = { id: head[2] ?? '', title: head[1]!.trim(), points: [] };
        doc.sections.push(section);
        block = 'section';
      } else if (bare === '## Intent') block = 'intent';
      else if (bare === '## Sources') block = 'sources';
      else {
        const parts = (direction![1] ?? '').split('·').map((s) => s.trim());
        doc.direction = { date: parts.find((p) => DATE.test(p)) ?? '', state: parts.includes('accepted') ? 'accepted' : 'proposed', scope: 'edit', bullets: [], changes: [] };
        block = 'direction';
      }
      continue;
    }

    if (block === 'head') {
      const target = /^Target:\s*(.*)$/.exec(bare);
      const kind = /^Kind:\s*(.*)$/.exec(bare);
      if (!titled && bare.startsWith('# ')) {
        doc.title = bare.slice(2).trim();
        titled = true;
      } else if (target?.[1]) doc.target = target[1];
      else if (kind && (KINDS as readonly string[]).includes(kind[1]!)) doc.kind = kind[1] as OutlineKind;
      else keep(doc, line);
    } else if (block === 'intent') {
      const m = INTENT.exec(bare);
      if (m) doc.intent.push({ key: m[1]!.trim(), text: m[2]!.trim() });
      else keep(doc, line);
    } else if (block === 'direction') {
      const d = doc.direction!;
      const scope = /^Scope:\s*(.*)$/.exec(bare);
      const from = /^From:\s*(.+)$/.exec(bare);
      const change = /^Change:\s*(.+)$/.exec(bare);
      if (scope && (SCOPES as readonly string[]).includes(scope[1]!)) d.scope = scope[1] as DirectionScope;
      else if (from) d.from = from[1]!;
      else if (bare.startsWith('- ')) d.bullets.push(bare.slice(2).trim());
      else if (change) d.changes.push(change[1]!);
      else keep(doc, line);
    } else if (block === 'section') {
      const m = POINT.exec(bare);
      const open = m ? OPEN.exec(m[1]!) : null;
      const body = (open ? open[1]! : m?.[1] ?? '').trim();
      if (m && body) {
        point = { id: m[2] ?? '', kind: open ? 'open' : 'point', text: body, cites: [] };
        section!.points.push(point);
      } else keep(section!, line);
    } else if (bare.startsWith('- ')) {
      const [first = '', ...rest] = bare.slice(2).split(SEP);
      const own = rest.length > 0 && SOURCE_ID.test(first.trim());
      source = own ? { id: first.trim(), title: rest.join(SEP).trim() } : { id: '', title: bare.slice(2).trim() };
      doc.sources.push(source);
    } else keep(doc, line);
  }
  assignIds(doc);
  return doc;
}

const pointLines = (p: OutlinePoint) => [
  `- ${p.kind === 'open' ? 'Open: ' : ''}${p.text} ^${p.id}`,
  ...p.cites.map((c) => `${INDENT}Cite: ${citeText(c)}`),
  ...(p.guide ? [`${INDENT}Guide: ${p.guide}`] : []),
  ...(p.keep ? [`${INDENT}Keep: ${p.keep}`] : []),
  ...(p.default ? [`${INDENT}Default: ${p.default}`] : []),
  ...(p.extra ?? []),
];

const sourceLines = (s: OutlineSource) => [
  `- ${s.id}${SEP}${s.title}`,
  ...(s.ref ? [`${INDENT}Ref: ${s.ref}`] : []),
  ...(s.supports ? [`${INDENT}Supports: ${s.supports}`] : []),
  ...(s.notShown ? [`${INDENT}Not shown: ${s.notShown}`] : []),
  ...(s.checked ? [`${INDENT}Checked: ${s.checked}`] : []),
  ...(s.extra ?? []),
];

const directionLines = (d: OutlineDirection) => [
  `## Direction${SEP}${d.date}${SEP}${d.state}`,
  `Scope: ${d.scope}`,
  ...(d.from ? [`From: ${d.from}`] : []),
  ...d.bullets.map((b) => `- ${b}`),
  ...d.changes.map((c) => `Change: ${c}`),
];

/** The canonical text for an outline. Parsing it gives the outline back. */
export function serializeOutline(doc: OutlineDoc): string {
  const blocks: string[][] = [[`# ${doc.title}`], [...(doc.target ? [`Target: ${doc.target}`] : []), `Kind: ${doc.kind}`, ...(doc.extra ?? [])]];
  if (doc.intent.length) blocks.push(['## Intent', ...doc.intent.map((l) => `${l.key}: ${l.text}`)]);
  if (doc.direction) blocks.push(directionLines(doc.direction));
  for (const s of doc.sections) blocks.push([`## ${s.title} ^${s.id}`, ...(s.extra ?? []), ...s.points.flatMap(pointLines)]);
  if (doc.sources.length) blocks.push(['## Sources', ...doc.sources.flatMap(sourceLines)]);
  return blocks.map((b) => b.join('\n')).join('\n\n') + '\n';
}

export class OutlineOpError extends Error {}
const fail = (message: string): never => {
  throw new OutlineOpError(message);
};

function oneLine(v: unknown, what: string, max = MAX_TEXT): string {
  if (typeof v !== 'string' || !v.trim()) return fail(`${what} is empty`);
  if (/[\r\n]/.test(v)) return fail(`${what} must be one line`);
  if (v.length > max) return fail(`${what} is over ${max} characters`);
  return v.trim();
}

/** Absent or blank gives undefined. */
const optional = (v: unknown, what: string, max?: number) => (v === undefined || v === '' ? undefined : oneLine(v, what, max));

/** `null` or blank clears the field. */
const clearable = (v: unknown, what: string, max?: number) => (v === null || v === '' ? null : optional(v, what, max));

const anId = (v: unknown, what: string) => (typeof v === 'string' && v.trim() ? v.trim() : fail(`${what} is missing`));

/** A batch label, such as `why`. Later ops refer to the new id as `@why`. */
const aLabel = (v: unknown) => {
  const label = optional(v, 'Label', 100);
  return label === undefined || SOURCE_ID.test(label) ? label : fail(`Label ${label} is a letter followed by letters, digits, _ or -`);
};

/** `null` puts it first; absent puts it last. */
const afterId = (v: unknown, what: string) => (v === null || v === undefined ? v : anId(v, what));

function oneOf<T extends string>(v: unknown, values: readonly T[], what: string): T {
  return (values as readonly unknown[]).includes(v) ? (v as T) : fail(`${what} is ${values.join(' | ')}`);
}

function aDate(v: unknown, what: string): string {
  return typeof v === 'string' && DATE.test(v) ? v : fail(`${what} is YYYY-MM-DD`);
}

function list(v: unknown, what: string): unknown[] {
  return Array.isArray(v) ? v : fail(`${what} is a list`);
}

function pointText(v: unknown): string {
  const text = oneLine(v, 'Point text');
  return OPEN.test(text) ? fail('Point text cannot start with Open:. Set kind open instead') : text;
}

function targetPath(v: unknown): string {
  const path = oneLine(v, 'Target', 1000);
  if (path.startsWith('/') || path.split('/').includes('..')) return fail('Target is a path inside the project');
  return path;
}

function cleanCite(v: unknown): OutlineCite {
  if (!v || typeof v !== 'object') return fail('Each cite is an object');
  const c = v as Record<string, unknown>;
  const source = oneLine(c.source, 'Cite source', 100);
  if (!SOURCE_ID.test(source.replace(/^@/, ''))) return fail(`Cite source ${source} is not a source id`);
  const location = optional(c.location, 'Cite location', 300);
  if (location?.split(SEP).some((p) => isMark(p.trim()))) return fail('Cite location cannot hold a mark word between · separators');
  const mark = c.mark === undefined || c.mark === null ? undefined : oneOf(c.mark, MARKS, 'Cite mark');
  const note = optional(c.note, 'Cite note', 1000);
  if (note && !mark) return fail('A cite note needs a mark');
  return { source, ...(location ? { location } : {}), ...(mark ? { mark } : {}), ...(note ? { note } : {}) };
}

const cleanCites = (v: unknown) => (v === undefined ? undefined : list(v, 'Cites').map(cleanCite));

function cleanIntent(v: unknown): OutlineIntentLine {
  if (!v || typeof v !== 'object') return fail('Each intent line is an object');
  const l = v as Record<string, unknown>;
  const key = oneLine(l.key, 'Intent key', 100);
  if (key.includes(':') || key.startsWith('#')) return fail('Intent key cannot hold : or start with #');
  return { key, text: oneLine(l.text, `Intent ${key}`) };
}

/** Drops absent fields, so a cleaned op holds only what it sets. */
const defined = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

function cleanOp(raw: unknown): OutlineOp {
  if (!raw || typeof raw !== 'object') return fail('Each op is an object');
  const o = raw as Record<string, unknown>;
  switch (o.op) {
    case 'setMeta': {
      const op = defined({
        op: 'setMeta' as const,
        title: optional(o.title, 'Title', 300),
        target: o.target === null ? null : o.target === undefined ? undefined : targetPath(o.target),
        kind: o.kind === undefined ? undefined : oneOf(o.kind, KINDS, 'Kind'),
      });
      return Object.keys(op).length > 1 ? op : fail('setMeta sets title, target or kind');
    }
    case 'setIntent':
      return { op: 'setIntent', lines: list(o.lines, 'Intent lines').map(cleanIntent) };
    case 'addSection':
      return defined({ op: 'addSection' as const, title: oneLine(o.title, 'Section title', 300), after: afterId(o.after, 'after'), label: aLabel(o.label) });
    case 'editSection':
      return { op: 'editSection', id: anId(o.id, 'Section id'), title: oneLine(o.title, 'Section title', 300) };
    case 'moveSection':
      return { op: 'moveSection', id: anId(o.id, 'Section id'), after: afterId(o.after, 'after') ?? null };
    case 'removeSection':
      return { op: 'removeSection', id: anId(o.id, 'Section id') };
    case 'addPoint':
      return defined({
        op: 'addPoint' as const,
        section: anId(o.section, 'Section id'),
        text: pointText(o.text),
        kind: o.kind === undefined ? undefined : oneOf(o.kind, ['point', 'open'] as const, 'Point kind'),
        after: afterId(o.after, 'after'),
        cites: cleanCites(o.cites),
        guide: optional(o.guide, 'Guide'),
        keep: optional(o.keep, 'Keep'),
        default: optional(o.default, 'Default'),
        label: aLabel(o.label),
      });
    case 'editPoint':
      return defined({
        op: 'editPoint' as const,
        id: anId(o.id, 'Point id'),
        text: o.text === undefined ? undefined : pointText(o.text),
        kind: o.kind === undefined ? undefined : oneOf(o.kind, ['point', 'open'] as const, 'Point kind'),
        cites: cleanCites(o.cites),
        guide: clearable(o.guide, 'Guide'),
        keep: clearable(o.keep, 'Keep'),
        default: clearable(o.default, 'Default'),
      });
    case 'movePoint':
      return { op: 'movePoint', id: anId(o.id, 'Point id'), section: anId(o.section, 'Section id'), after: afterId(o.after, 'after') ?? null };
    case 'removePoint':
      return { op: 'removePoint', id: anId(o.id, 'Point id') };
    case 'addSource': {
      const id = optional(o.id, 'Source id', 100);
      if (id && !SOURCE_ID.test(id)) return fail(`Source id ${id} is a letter followed by letters, digits, _ or -`);
      return defined({
        op: 'addSource' as const,
        title: oneLine(o.title, 'Source title', 500),
        id,
        ref: optional(o.ref, 'Ref', 1000),
        supports: optional(o.supports, 'Supports'),
        notShown: optional(o.notShown, 'Not shown'),
        label: aLabel(o.label),
      });
    }
    case 'editSource':
      return defined({
        op: 'editSource' as const,
        id: anId(o.id, 'Source id'),
        title: optional(o.title, 'Source title', 500),
        ref: clearable(o.ref, 'Ref', 1000),
        supports: clearable(o.supports, 'Supports'),
        notShown: clearable(o.notShown, 'Not shown'),
        checked: o.checked === null || o.checked === '' ? null : o.checked === undefined ? undefined : aDate(o.checked, 'Checked'),
      });
    case 'removeSource':
      return { op: 'removeSource', id: anId(o.id, 'Source id') };
    case 'setDirection': {
      if (!o.direction || typeof o.direction !== 'object') return fail('setDirection takes a direction');
      const d = o.direction as Record<string, unknown>;
      return {
        op: 'setDirection',
        direction: defined({
          date: d.date === undefined ? undefined : aDate(d.date, 'Direction date'),
          state: oneOf(d.state ?? 'proposed', ['proposed', 'accepted'] as const, 'Direction state'),
          scope: oneOf(d.scope, SCOPES, 'Direction scope'),
          from: optional(d.from, 'From', 500),
          bullets: list(d.bullets ?? [], 'Direction bullets').map((b) => oneLine(b, 'Direction bullet')),
          changes: list(d.changes ?? [], 'Direction changes').map((c) => oneLine(c, 'Direction change')),
        }),
      };
    }
    case 'clearDirection':
      return { op: 'clearDirection' };
    default:
      return fail(`Unknown op ${String(o.op)}`);
  }
}

/** Checks the shape of each op, and gives the ops trimmed. Takes a list or `{ ops: [...] }`. */
export function cleanOutlineOps(raw: unknown): OutlineOp[] {
  const ops = raw && typeof raw === 'object' && !Array.isArray(raw) && 'ops' in raw ? (raw as { ops: unknown }).ops : raw;
  if (!Array.isArray(ops) || ops.length === 0) return fail('Expected ops');
  if (ops.length > MAX_OPS) return fail(`At most ${MAX_OPS} ops at once`);
  return ops.map((op, i) => {
    try {
      return cleanOp(op);
    } catch (e) {
      throw e instanceof OutlineOpError ? new OutlineOpError(`ops[${i}]: ${e.message}`) : e;
    }
  });
}

const numberAfter = (ids: string[], prefix: string) => {
  const own = new RegExp(`^${prefix}(\\d+)$`);
  return `${prefix}${Math.max(0, ...ids.map((id) => Number(own.exec(id)?.[1] ?? 0))) + 1}`;
};

/** The index to insert at: first for `null`, last for undefined, else after the id. */
function slot(ids: string[], after: string | null | undefined, what: string): number {
  if (after === undefined) return ids.length;
  if (after === null) return 0;
  const at = ids.indexOf(after);
  return at >= 0 ? at + 1 : fail(`There is no ${what} ${after}`);
}

function sectionOf(doc: OutlineDoc, id: string): OutlineSection {
  return doc.sections.find((s) => s.id === id) ?? fail(`There is no section ${id}`);
}

function pointOf(doc: OutlineDoc, id: string): { section: OutlineSection; point: OutlinePoint } {
  for (const section of doc.sections) {
    const point = section.points.find((p) => p.id === id);
    if (point) return { section, point };
  }
  return fail(`There is no point ${id}`);
}

function sourceOf(doc: OutlineDoc, id: string): OutlineSource {
  return doc.sources.find((s) => s.id === id) ?? fail(`There is no source ${id}`);
}

function checkCites(doc: OutlineDoc, cites: OutlineCite[] | undefined) {
  for (const c of cites ?? []) if (!doc.sources.some((s) => s.id === c.source)) fail(`There is no source ${c.source}. Add it with addSource first`);
}

/** Sets a field, or deletes it for `null`. */
function assign<T extends object, K extends keyof T>(target: T, key: K, value: T[K] | null | undefined) {
  if (value === null) delete target[key];
  else if (value !== undefined) target[key] = value;
}

function applyOp(doc: OutlineDoc, op: OutlineOp, date: string, added: string[]) {
  switch (op.op) {
    case 'setMeta':
      assign(doc, 'title', op.title);
      assign(doc, 'target', op.target);
      assign(doc, 'kind', op.kind);
      return;
    case 'setIntent':
      doc.intent = op.lines;
      return;
    case 'addSection': {
      const id = numberAfter(doc.sections.map((s) => s.id), 's');
      doc.sections.splice(slot(doc.sections.map((s) => s.id), op.after, 'section'), 0, { id, title: op.title, points: [] });
      added.push(id);
      return;
    }
    case 'editSection':
      sectionOf(doc, op.id).title = op.title;
      return;
    case 'moveSection': {
      const section = sectionOf(doc, op.id);
      if (op.after === op.id) return fail('A section cannot move after itself');
      doc.sections.splice(doc.sections.indexOf(section), 1);
      doc.sections.splice(slot(doc.sections.map((s) => s.id), op.after, 'section'), 0, section);
      return;
    }
    case 'removeSection':
      doc.sections.splice(doc.sections.indexOf(sectionOf(doc, op.id)), 1);
      return;
    case 'addPoint': {
      const section = sectionOf(doc, op.section);
      checkCites(doc, op.cites);
      const id = numberAfter(doc.sections.flatMap((s) => s.points.map((p) => p.id)), 'p');
      const point: OutlinePoint = { id, kind: op.kind ?? 'point', text: op.text, cites: op.cites ?? [] };
      assign(point, 'guide', op.guide);
      assign(point, 'keep', op.keep);
      assign(point, 'default', op.default);
      section.points.splice(slot(section.points.map((p) => p.id), op.after, `point in ${section.id}`), 0, point);
      added.push(id);
      return;
    }
    case 'editPoint': {
      const { point } = pointOf(doc, op.id);
      checkCites(doc, op.cites);
      assign(point, 'text', op.text);
      assign(point, 'kind', op.kind);
      assign(point, 'cites', op.cites);
      assign(point, 'guide', op.guide);
      assign(point, 'keep', op.keep);
      assign(point, 'default', op.default);
      return;
    }
    case 'movePoint': {
      const { section, point } = pointOf(doc, op.id);
      const into = sectionOf(doc, op.section);
      if (op.after === op.id) return fail('A point cannot move after itself');
      section.points.splice(section.points.indexOf(point), 1);
      into.points.splice(slot(into.points.map((p) => p.id), op.after, `point in ${into.id}`), 0, point);
      return;
    }
    case 'removePoint': {
      const { section, point } = pointOf(doc, op.id);
      section.points.splice(section.points.indexOf(point), 1);
      return;
    }
    case 'addSource': {
      const id = op.id ?? numberAfter(doc.sources.map((s) => s.id), 'S');
      if (doc.sources.some((s) => s.id === id)) return fail(`Source ${id} already exists`);
      const source: OutlineSource = { id, title: op.title };
      assign(source, 'ref', op.ref);
      assign(source, 'supports', op.supports);
      assign(source, 'notShown', op.notShown);
      doc.sources.push(source);
      added.push(id);
      return;
    }
    case 'editSource': {
      const source = sourceOf(doc, op.id);
      assign(source, 'title', op.title);
      assign(source, 'ref', op.ref);
      assign(source, 'supports', op.supports);
      assign(source, 'notShown', op.notShown);
      assign(source, 'checked', op.checked);
      return;
    }
    case 'removeSource': {
      doc.sources.splice(doc.sources.indexOf(sourceOf(doc, op.id)), 1);
      for (const s of doc.sections) for (const p of s.points) p.cites = p.cites.filter((c) => c.source !== op.id);
      return;
    }
    case 'setDirection': {
      const { date: when, from, ...rest } = op.direction;
      doc.direction = { date: when ?? date, ...rest, ...(from ? { from } : {}) };
      return;
    }
    case 'clearDirection':
      delete doc.direction;
      return;
  }
}

/**
 * Applies ops to the outline's text, or to a new outline when `before` is undefined, and gives the
 * canonical text back. Throws OutlineOpError on the first bad op, so a failed update changes nothing.
 */
/** Replaces `@<label>` ids with the ids earlier ops in the batch created. */
function withLabels(op: OutlineOp, labels: Map<string, string>): OutlineOp {
  const id = (v: string) => {
    if (!v.startsWith('@')) return v;
    return labels.get(v.slice(1)) ?? fail(`No earlier op in this batch has label ${v.slice(1)}`);
  };
  const o = { ...op } as Record<string, unknown>;
  for (const key of ['id', 'section', 'after'] as const) if (typeof o[key] === 'string') o[key] = id(o[key] as string);
  if (Array.isArray(o.cites)) o.cites = (o.cites as OutlineCite[]).map((c) => ({ ...c, source: id(c.source) }));
  return o as unknown as OutlineOp;
}

export function applyOutlineOps(before: string | undefined, opts: { ops: unknown; date: string }): { text: string; doc: OutlineDoc; added: string[] } {
  const ops = cleanOutlineOps(opts.ops);
  if (before === undefined && !ops.some((op) => op.op === 'setMeta' && op.title)) fail('A new outline needs a setMeta op with a title');
  const doc = before === undefined ? { title: '', kind: 'document' as const, intent: [], sections: [], sources: [] } : parseOutline(before);
  const added: string[] = [];
  const labels = new Map<string, string>();
  ops.forEach((op, i) => {
    try {
      const resolved = withLabels(op, labels);
      applyOp(doc, resolved, opts.date, added);
      const label = 'label' in resolved ? resolved.label : undefined;
      if (label) {
        if (labels.has(label)) fail(`Label ${label} is already used in this batch. Sources, sections and points share labels`);
        labels.set(label, added[added.length - 1]);
      }
    } catch (e) {
      throw e instanceof OutlineOpError ? new OutlineOpError(`ops[${i}] ${op.op}: ${e.message}`) : e;
    }
  });
  const text = serializeOutline(doc);
  return { text, doc: parseOutline(text), added };
}

/** Counts for the project list. */
export function outlineSummary(path: string, doc: OutlineDoc): OutlineSummary {
  const points = doc.sections.flatMap((s) => s.points);
  const cites = points.flatMap((p) => p.cites);
  return {
    path,
    title: doc.title,
    ...(doc.target ? { target: doc.target } : {}),
    kind: doc.kind,
    sections: doc.sections.length,
    points: points.length,
    open: points.filter((p) => p.kind === 'open').length,
    cites: cites.length,
    unchecked: cites.filter((c) => !c.mark).length,
    flagged: cites.filter((c) => c.mark && c.mark !== 'supports').length,
    ...(doc.direction ? { direction: doc.direction.state } : {}),
  };
}
