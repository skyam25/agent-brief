/**
 * The initiative brief file: front matter with `agent_brief_id`, a `# Title`, then `## ` sections.
 *
 * Understanding, Decisions, Open and Folders are parsed. Every other section, and anything
 * before the first section, stays raw text and is written back unchanged. Formatting with no
 * changed field gives back the same text.
 */

import { INITIATIVE_ROLES, type InitiativeFolder, type InitiativeRole } from '../protocol';

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
};

const HEADING = /^##[ \t]+(.+?)[ \t#]*$/;
const FENCE = /^\s*(```|~~~)/;
const ITEM = /^ ?[-*+][ \t]+(.*)$/;
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
  };
}

const listBody = (lines: string[]) => (lines.length ? lines.map((l) => `- ${l}`).join('\n') + '\n\n' : '\n');

function fieldBody(field: FieldName, fields: BriefFields): string {
  if (field === 'understanding') return fields.understanding.trim() ? `${fields.understanding.trim()}\n\n` : '\n';
  if (field === 'folders') return listBody(fields.folders.map(folderRow));
  return listBody(fields[field]);
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
    const body = fieldBody(field, fields);
    if (at !== -1) {
      sections[at].body = body;
      continue;
    }
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
export function newBrief(opts: BriefFields & { id: string; title: string; working?: string[] }): string {
  const parts = [`---\nagent_brief_id: "${opts.id}"\n---\n# ${opts.title}\n\n`];
  for (const name of SECTION_ORDER) {
    const field = (Object.keys(FIELD_SECTION) as FieldName[]).find((f) => FIELD_SECTION[f] === name);
    const body = field ? fieldBody(field, opts) : name === 'Working' ? listBody(opts.working ?? []) : '\n';
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
