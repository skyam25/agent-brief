/**
 * The initiative brief file: front matter with `agent_brief_id`, a `# Title`, then `## ` sections.
 *
 * Understanding, Decisions, Open, Outputs and Folders are parsed. Every other section, and anything
 * before the first section, stays raw text and is written back unchanged. Formatting with no
 * changed field gives back the same text. A changed list rewrites only its item lines, so the
 * PM's sub-bullets, prose and rows the field skips stay where they were.
 */

import { INITIATIVE_ROLES, type InitiativeFolder, type InitiativeRole } from '../protocol';
import { briefLinks, FENCE, HEADING } from '../shared/brief-sections';

export interface BriefSection {
  /** The heading's name, as written. */
  name: string;
  /** The heading line. */
  heading: string;
  /** Everything after the heading line up to the next section, newlines included. */
  body: string;
}

/** The fields the app reads and writes. */
export interface BriefFields {
  understanding: string;
  decisions: string[];
  open: string[];
  folders: InitiativeFolder[];
  /** Rows of the Outputs section, without the leading `- `. */
  outputs: string[];
}

export interface ParsedBrief extends BriefFields {
  /** `agent_brief_id` from the front matter. */
  id?: string;
  title: string;
  /** Front matter, title and any text before the first section. */
  head: string;
  sections: BriefSection[];
}

/** Section order for a new brief, and for placing a section the file lacks. */
export const SECTION_ORDER = ['Understanding', 'Decisions', 'Open', 'Working', 'Outputs', 'Sources', 'Grounding', 'Folders'];

type FieldName = keyof BriefFields;

const FIELD_SECTION: Record<FieldName, string> = {
  understanding: 'Understanding',
  decisions: 'Decisions',
  open: 'Open',
  folders: 'Folders',
  outputs: 'Outputs',
};

const ITEM = /^ ?[-*+][ \t]+(.*)$/;
const MARKER = /^ ?[-*+][ \t]+/;
const INDENTED = /^(?:\t| {2,})\S/;
const ARROW = /\s+(?:→|->)\s+/;

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.toLowerCase();

/** Splits the text into its head and `## ` sections. Headings inside code fences do not count. */
function split(text: string): { head: string; sections: BriefSection[] } {
  const lines = text.split('\n');
  const starts: number[] = [];
  let fenced = false;
  lines.forEach((line, i) => {
    if (FENCE.test(line)) fenced = !fenced;
    else if (!fenced && HEADING.test(line)) starts.push(i);
  });
  if (starts.length === 0) return { head: text, sections: [] };
  const head = starts[0] > 0 ? lines.slice(0, starts[0]).join('\n') + '\n' : '';
  const sections = starts.map((start, k) => {
    const end = starts[k + 1] ?? lines.length;
    const body = lines.slice(start + 1, end).join('\n') + (k + 1 < starts.length ? '\n' : '');
    return { name: HEADING.exec(lines[start])![1], heading: lines[start], body };
  });
  return { head, sections };
}

function frontMatterId(head: string): string | undefined {
  const m = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(head);
  if (!m) return undefined;
  const line = /^agent_brief_id:[ \t]*(.*)$/m.exec(m[1]);
  const value = line?.[1].trim().replace(/^(["'])(.*)\1$/, '$2');
  return value || undefined;
}

function titleOf(head: string): string {
  const body = head.replace(/^---\n[\s\S]*?\n---(?:\n|$)/, '');
  const m = /^#[ \t]+(.+?)[ \t#]*$/m.exec(body);
  return m ? m[1] : '';
}

/** List items at the top level, without their markers. */
function items(body: string): string[] {
  return body
    .split('\n')
    .map((line) => ITEM.exec(line)?.[1].trim())
    .filter((item): item is string => !!item);
}

/** `- <path> → <role>` with an optional ` · <note>`. Rows with another role are left out. */
export function parseFolderRow(line: string): InitiativeFolder | undefined {
  const parts = line.split(ARROW);
  if (parts.length < 2) return undefined;
  const right = parts.pop()!;
  const path = parts.join(' → ').trim();
  const [rawRole, ...rest] = right.split(/\s+·\s+/);
  const role = rawRole.trim().toLowerCase() as InitiativeRole;
  if (!path || !INITIATIVE_ROLES.includes(role)) return undefined;
  const note = rest.join(' · ').trim();
  return { path, role, ...(note ? { note } : {}) };
}

export const folderRow = (f: InitiativeFolder): string => `${f.path} → ${f.role}${f.note ? ` · ${f.note}` : ''}`;

export function parseBrief(text: string): ParsedBrief {
  const { head, sections } = split(text.replace(/\r\n/g, '\n'));
  const body = (name: string) => sections.find((s) => sameName(s.name, name))?.body ?? '';
  return {
    id: frontMatterId(head),
    title: titleOf(head),
    head,
    sections,
    understanding: body('Understanding').trim(),
    decisions: items(body('Decisions')),
    open: items(body('Open')),
    folders: items(body('Folders')).flatMap((row) => parseFolderRow(row) ?? []),
    outputs: items(body('Outputs')),
  };
}

const listBody = (lines: string[]) => (lines.length ? lines.map((l) => `- ${l}`).join('\n') + '\n\n' : '\n');

function fieldBody(field: FieldName, fields: BriefFields): string {
  if (field === 'understanding') return fields.understanding.trim() ? `${fields.understanding.trim()}\n\n` : '\n';
  if (field === 'folders') return listBody(fields.folders.map(folderRow));
  return listBody(fields[field]);
}

/** The key a list field reads from an item's text, or undefined for an item it skips. */
type ItemKey = (text: string) => string | undefined;

const lineKey: ItemKey = (text) => text || undefined;

const folderKey: ItemKey = (text) => {
  const f = parseFolderRow(text);
  return f && folderRow(f);
};

interface ListLine {
  line: string;
  /** Set for an item the field reads. */
  key?: string;
  /** The indented lines under an item, with the blank lines between them. */
  under: string[];
}

function listLines(body: string, key: ItemKey): ListLine[] {
  const lines: ListLine[] = [];
  const text = body.replace(/\s+$/, '');
  if (!text) return lines;
  for (const line of text.split('\n')) {
    const item = ITEM.exec(line)?.[1].trim();
    const k = item === undefined ? undefined : key(item);
    if (k !== undefined) {
      lines.push({ line, key: k, under: [] });
      continue;
    }
    if (INDENTED.test(line)) {
      let i = lines.length - 1;
      while (i >= 0 && lines[i].key === undefined && !lines[i].line.trim()) i--;
      if (i >= 0 && lines[i].key !== undefined) {
        lines[i].under.push(...lines.splice(i + 1).map((l) => l.line), line);
        continue;
      }
    }
    lines.push({ line, under: [] });
  }
  return lines;
}

/** Index pairs of a longest common subsequence of `a` and `b`, in order. */
function common(a: string[], b: string[]): [number, number][] {
  const len = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) len[i][j] = a[i] === b[j] ? len[i + 1][j + 1] + 1 : Math.max(len[i + 1][j], len[i][j + 1]);
  }
  const pairs: [number, number][] = [];
  for (let i = 0, j = 0; i < a.length && j < b.length; ) {
    if (a[i] === b[j]) pairs.push([i++, j++]);
    else if (len[i + 1][j] >= len[i][j + 1]) i++;
    else j++;
  }
  return pairs;
}

/**
 * Rewrites the items of a list section to `next` in place. Items that stay keep their line and
 * the lines under them. Between two kept items, changed items take the old ones' places in order,
 * and the extra ones go after them. Every line the field does not read stays.
 */
function mergeList(body: string, next: string[], key: ItemKey): string {
  const lines = listLines(body, key);
  const slots = lines.flatMap((l, at) => (l.key === undefined ? [] : [at]));
  const pairs = common(
    slots.map((at) => lines[at].key!),
    next.map((t) => key(t) ?? t),
  );
  const rewrite = new Map<number, string>();
  const drop = new Set<number>();
  // New items by the line index they go before.
  const inserts = new Map<number, string[]>();
  let o = 0;
  let n = 0;
  for (const [po, pn] of [...pairs, [slots.length, next.length]]) {
    const olds = slots.slice(o, po);
    const news = next.slice(n, pn);
    olds.forEach((at, k) => (k < news.length ? rewrite.set(at, news[k]) : drop.add(at)));
    const extra = news.slice(olds.length);
    if (extra.length) {
      const at = olds.length ? olds[olds.length - 1] + 1 : o > 0 ? slots[o - 1] + 1 : po < slots.length ? slots[po] : lines.length;
      inserts.set(at, [...(inserts.get(at) ?? []), ...extra]);
    }
    o = po + 1;
    n = pn + 1;
  }
  const out: string[] = [];
  for (let at = 0; at <= lines.length; at++) {
    const added = inserts.get(at) ?? [];
    // Items after prose start their own paragraph.
    const last = out[out.length - 1];
    if (added.length && at === lines.length && last?.trim() && !ITEM.test(last) && !INDENTED.test(last)) out.push('');
    out.push(...added.map((t) => `- ${t}`));
    if (at === lines.length || drop.has(at)) continue;
    const l = lines[at];
    const text = rewrite.get(at);
    out.push(text === undefined ? l.line : MARKER.exec(l.line)![0] + text, ...l.under);
  }
  const kept = out.filter((line, i) => line.trim() || i === 0 || out[i - 1].trim());
  const text = kept.join('\n').replace(/\s+$/, '');
  return text ? `${text}\n\n` : '\n';
}

/** The new body of a field's existing section. */
function mergedBody(field: FieldName, body: string, fields: BriefFields): string {
  if (field === 'understanding') return fieldBody(field, fields);
  if (field === 'folders') return mergeList(body, fields.folders.map(folderRow), folderKey);
  return mergeList(body, fields[field], lineKey);
}

/** Puts a new section before the first one that comes after it in SECTION_ORDER, else at the end. */
function insertAt(sections: BriefSection[], name: string): number {
  const rank = SECTION_ORDER.indexOf(name);
  const i = sections.findIndex((s) => {
    const r = SECTION_ORDER.findIndex((n) => sameName(s.name, n));
    return r > rank;
  });
  return i === -1 ? sections.length : i;
}

/** The fields whose values differ between two briefs. */
export function changedFields(before: BriefFields, after: BriefFields): FieldName[] {
  return (Object.keys(FIELD_SECTION) as FieldName[]).filter((f) => JSON.stringify(before[f]) !== JSON.stringify(after[f]));
}

/** Writes `fields` into `base`, replacing only the sections whose field changed. */
export function formatBrief(base: ParsedBrief, fields: BriefFields): string {
  const sections = base.sections.map((s) => ({ ...s }));
  const changed = changedFields(base, fields);
  if (changed.length === 0) return base.head + sections.map((s) => `${s.heading}\n${s.body}`).join('');
  for (const field of changed) {
    const name = FIELD_SECTION[field];
    const at = sections.findIndex((s) => sameName(s.name, name));
    if (at !== -1) {
      sections[at].body = mergedBody(field, sections[at].body, fields);
      continue;
    }
    const body = fieldBody(field, fields);
    const i = insertAt(sections, name);
    // A section that ended the file gains the blank line that separates sections.
    if (i > 0 && !sections[i - 1].body.endsWith('\n\n')) sections[i - 1].body = sections[i - 1].body.replace(/\n*$/, '\n\n');
    sections.splice(i, 0, { name, heading: `## ${name}`, body });
  }
  let head = base.head;
  // A brief that had no sections gets a blank line between its title and the first one.
  if (base.sections.length === 0 && head && !head.endsWith('\n\n')) head = head.replace(/\n*$/, '\n\n');
  const text = head + sections.map((s) => `${s.heading}\n${s.body}`).join('');
  return text.replace(/\n*$/, '\n');
}

/** A new brief with every section, the empty ones as a heading alone. */
export function newBrief(opts: Omit<BriefFields, 'outputs'> & { id: string; title: string; working?: string[]; outputs?: string[] }): string {
  const fields: BriefFields = { ...opts, outputs: opts.outputs ?? [] };
  const parts = [`---\nagent_brief_id: "${opts.id}"\n---\n# ${opts.title}\n\n`];
  for (const name of SECTION_ORDER) {
    const field = (Object.keys(FIELD_SECTION) as FieldName[]).find((f) => FIELD_SECTION[f] === name);
    const body = field ? fieldBody(field, fields) : name === 'Working' ? listBody(opts.working ?? []) : '\n';
    parts.push(`## ${name}\n${body}`);
  }
  return parts.join('').replace(/\n*$/, '\n');
}

/** `<Title> brief.md`, with characters a file name cannot hold replaced. */
export function briefFileName(title: string): string {
  const safe = title
    .replace(/[/\\:\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 80);
  return `${safe || 'Initiative'} brief.md`;
}

/** The first sentence of Understanding, at most 160 characters. */
export function firstSentence(text: string): string {
  const line = text.trim().split('\n')[0] ?? '';
  const m = /^(.+?[.!?])(?:\s|$)/.exec(line);
  const sentence = (m ? m[1] : line).trim();
  return sentence.length > 160 ? `${sentence.slice(0, 159).trimEnd()}…` : sentence;
}

/** What an Outputs row links to: a file by its absolute path, or a URL. */
export interface OutputLink {
  title: string;
  path?: string;
  url?: string;
}

const linkText = (text: string) => text.replace(/[[\]]/g, '\\$&');

/** The link a file row ends with, or a URL row's destination. */
function linkPart(o: OutputLink): string {
  if (o.url) return `(${/[\s()<>]/.test(o.url) ? `<${o.url}>` : o.url})`;
  const path = o.path ?? '';
  const name = path.split('/').filter(Boolean).at(-1) ?? path;
  return ` [${linkText(name)}](<file:${path}>)`;
}

/** `<title> [<file name>](<file:<path>>)` for a file, `[<title>](<url>)` for a URL. */
export function outputRow(o: OutputLink): string {
  return o.url ? `[${linkText(o.title)}]${linkPart(o)}` : `${o.title}${linkPart(o)}`;
}

/** True when the row reads as `outputRow` wrote it, whatever its title. */
const generated = (row: string, o: OutputLink) => (o.url ? row.startsWith('[') && row.endsWith(`]${linkPart(o)}`) : row.endsWith(linkPart(o)));

/** The path or URL a row's last Markdown link points at. A `file:` link gives its path. */
export const outputRowTarget = (row: string): string | undefined => briefLinks(row).at(-1)?.target || undefined;

/**
 * Adds a row for each link the rows lack, keyed by path or URL. A row in the written shape takes
 * a changed title in place. Rows the user wrote or reworded stay as they are.
 */
export function mergeOutputRows(rows: readonly string[], links: readonly OutputLink[]): string[] {
  const next = [...rows];
  for (const link of links) {
    const at = next.findIndex((r) => outputRowTarget(r) === (link.url ?? link.path));
    if (at === -1) next.push(outputRow(link));
    else if (generated(next[at], link)) next[at] = outputRow(link);
  }
  return next;
}
