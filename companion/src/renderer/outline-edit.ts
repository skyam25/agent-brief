/**
 * The outline editor's pure parts: cite chips, the ops a row edit makes, rows not yet
 * written to the file, the direction banner's words, and the retry on a stale version.
 * The source line here also serves a note opened from a file.
 */

import type { CiteMark, DirectionScope, OutlineCite, OutlineDoc, OutlineIntentLine, OutlineKind, OutlineOp, OutlinePoint, OutlineSection } from '../protocol';

export const MARK_GLYPH: Record<CiteMark, string> = { supports: '✓', partly: '~', not: '✗', unknown: '?' };

/** A chip's label, such as `S1 ✓`. An unchecked cite shows its source alone. */
export const citeLabel = (c: OutlineCite) => (c.mark ? `${c.source} ${MARK_GLYPH[c.mark]}` : c.source);

/** A chip's tooltip: the source, where in it, the mark and why. */
export function citeTitle(c: OutlineCite, sourceTitle?: string): string {
  return [sourceTitle ? `${c.source} · ${sourceTitle}` : c.source, c.location, c.mark ?? 'unchecked', c.note].filter(Boolean).join(' · ');
}

/** A cite as the file can hold it. A note needs a mark, so a cite without one drops its note. */
export function cleanCite(c: OutlineCite): OutlineCite {
  const location = c.location?.trim();
  const note = c.mark ? c.note?.trim() : undefined;
  return { source: c.source, ...(location ? { location } : {}), ...(c.mark ? { mark: c.mark } : {}), ...(note ? { note } : {}) };
}

/** The cites with the one at `index` replaced, or removed when `next` is undefined. */
export function citesWith(cites: OutlineCite[], index: number, next?: OutlineCite): OutlineCite[] {
  const list = [...cites];
  if (next) list[index] = next;
  else list.splice(index, 1);
  return list.map(cleanCite);
}

const OPEN = /^open:\s*/i;

/** Typed point text on one line. A leading `Open:` makes it an open point. */
export function splitOpen(typed: string): { text: string; kind?: 'open' } {
  const line = typed.replace(/\s+/g, ' ').trim();
  return OPEN.test(line) ? { text: line.replace(OPEN, '').trim(), kind: 'open' } : { text: line };
}

/** The edit a point's typed text makes. Undefined when the text is blank or unchanged. */
export function pointTextOp(point: OutlinePoint, typed: string): OutlineOp | undefined {
  const { text, kind } = splitOpen(typed);
  if (!text || (text === point.text && (!kind || kind === point.kind))) return undefined;
  return { op: 'editPoint', id: point.id, text, ...(kind && kind !== point.kind ? { kind } : {}) };
}

/** Alt+↑ or Alt+↓ on a point. At a section's edge it crosses into the next section. Undefined at the outline's ends. */
export function pointMoveOp(doc: Pick<OutlineDoc, 'sections'>, id: string, dir: -1 | 1): OutlineOp | undefined {
  const s = doc.sections.findIndex((x) => x.points.some((p) => p.id === id));
  if (s === -1) return undefined;
  const section = doc.sections[s]!;
  const ids = section.points.map((p) => p.id);
  const to = ids.indexOf(id) + dir;
  if (to >= 0 && to < ids.length) {
    // The point lands after the one before its new slot, counted without it.
    const rest = ids.filter((x) => x !== id);
    return { op: 'movePoint', id, section: section.id, after: to === 0 ? null : rest[to - 1]! };
  }
  const next = doc.sections[s + dir];
  if (!next) return undefined;
  return { op: 'movePoint', id, section: next.id, after: dir === 1 ? null : (next.points.at(-1)?.id ?? null) };
}

/** The intent keys the editor always offers. */
export const INTENT_KEYS = ['Reader', 'Goal', 'Message', 'Guide'];

/** The intent rows to show: the file's lines, then each offered key it lacks, blank. */
export function intentRows(intent: OutlineIntentLine[]): OutlineIntentLine[] {
  const have = new Set(intent.map((l) => l.key));
  return [...intent, ...INTENT_KEYS.filter((k) => !have.has(k)).map((key) => ({ key, text: '' }))];
}

/** The setIntent for one row's new text. Blank rows drop. Undefined when nothing changed. */
export function intentOp(intent: OutlineIntentLine[], key: string, typed: string): OutlineOp | undefined {
  const text = typed.replace(/\s+/g, ' ').trim();
  if ((intent.find((l) => l.key === key)?.text ?? '') === text) return undefined;
  const lines = intentRows(intent).map((l) => (l.key === key ? { key, text } : l));
  return { op: 'setIntent', lines: lines.filter((l) => l.text) };
}

/** The kind a target's extension suggests. */
export const kindFor = (target: string): OutlineKind | undefined => (/\.html?$/i.test(target.trim()) ? 'page' : target.trim() ? 'document' : undefined);

/** What Generate and the target tab name: the target's file name, or the kind. */
export const targetName = (doc: Pick<OutlineDoc, 'target' | 'kind'>) => (doc.target ? doc.target.split('/').at(-1)! : doc.kind);

/** A point not yet in the file. It follows a written point, `null` for first, or another pending row. */
export type PendingAfter = { id: string | null } | { key: string };

export interface PendingPoint {
  key: string;
  section: string;
  after: PendingAfter;
}

export type PointRow = { kind: 'point'; point: OutlinePoint } | { kind: 'pending'; pending: PendingPoint };

const follows = (a: PendingAfter, b: PendingAfter) => ('key' in a ? 'key' in b && a.key === b.key : 'id' in b && a.id === b.id);

/** A section's rows: its points, with pending rows slotted in after what they follow. A pending row whose anchor is gone goes last. */
export function sectionRows(section: OutlineSection, pending: PendingPoint[]): PointRow[] {
  const mine = pending.filter((p) => p.section === section.id);
  const placed = new Set<string>();
  const rows: PointRow[] = [];
  const after = (anchor: PendingAfter) => {
    for (const p of mine) {
      if (placed.has(p.key) || !follows(p.after, anchor)) continue;
      placed.add(p.key);
      rows.push({ kind: 'pending', pending: p });
      after({ key: p.key });
    }
  };
  after({ id: null });
  for (const point of section.points) {
    rows.push({ kind: 'point', point });
    after({ id: point.id });
  }
  for (const p of mine) {
    if (placed.has(p.key)) continue;
    placed.add(p.key);
    rows.push({ kind: 'pending', pending: p });
    after({ key: p.key });
  }
  return rows;
}

/** A pending row became point `id`. Rows that followed it now follow the point. */
export function resolvePending(pending: PendingPoint[], key: string, id: string): PendingPoint[] {
  return pending.filter((p) => p.key !== key).map((p) => ('key' in p.after && p.after.key === key ? { ...p, after: { id } } : p));
}

/** Drops a pending row. Rows that followed it follow what it followed. */
export function dropPending(pending: PendingPoint[], key: string): PendingPoint[] {
  const gone = pending.find((p) => p.key === key);
  if (!gone) return pending;
  return pending.filter((p) => p !== gone).map((p) => ('key' in p.after && p.after.key === key ? { ...p, after: gone.after } : p));
}

/** The addPoint for a pending row. A row still following an unwritten one goes last. */
export function addPendingOp(p: PendingPoint, typed: string): OutlineOp | undefined {
  const { text, kind } = splitOpen(typed);
  if (!text) return undefined;
  return { op: 'addPoint', section: p.section, text, ...(kind ? { kind } : {}), ...('id' in p.after ? { after: p.after.id } : {}) };
}

/** A wrapped field's text with pasted line breaks turned to spaces. The file holds each field on one line. */
export const oneLine = (typed: string) => typed.replace(/\r?\n|\r/g, ' ');

/**
 * Whether ↑ or ↓ leaves a wrapped field for the row beside it. It does when the caret's
 * visual line is the field's first line for ↑, or its last line for ↓. Tops are in pixels.
 */
export function leavesRow(dir: -1 | 1, tops: { caret: number; first: number; last: number }): boolean {
  return dir === -1 ? tops.caret <= tops.first + 1 : tops.caret >= tops.last - 1;
}

/** A note's line about the file it came from. With an outline, Send revises the outline first. */
export function sourceLine(path: string, outline?: string): string {
  return outline
    ? `From ${path}. Send folds your comments into ${outline} first, and Claude proposes a direction there.`
    : `From ${path}. Send asks Claude to apply your changes to the file.`;
}

/** The direction banner's change lines shown before Show more. */
export const CHANGES_SHOWN = 4;

/** The change lines to show, and how many more the toggle reveals. */
export function shownChanges(changes: string[], all: boolean): { shown: string[]; more: number } {
  if (all || changes.length <= CHANGES_SHOWN) return { shown: changes, more: 0 };
  return { shown: changes.slice(0, CHANGES_SHOWN), more: changes.length - CHANGES_SHOWN };
}

/** The Accept button, named by how far the revision reaches. */
export const ACCEPT_LABEL: Record<DirectionScope, string> = {
  edit: 'Accept and edit',
  sections: 'Accept and rewrite sections',
  regenerate: 'Accept and regenerate',
};

export function scopeLine(scope: DirectionScope, doc: Pick<OutlineDoc, 'target' | 'kind'>): string {
  const what = doc.target ?? `the ${doc.kind}`;
  if (scope === 'edit') return `Scope · edit passages of ${what} in place`;
  if (scope === 'sections') return `Scope · rewrite the affected sections of ${what}`;
  return `Scope · regenerate ${what} from the outline`;
}

export function directionHeadline(doc: Pick<OutlineDoc, 'target' | 'kind' | 'direction'>): string {
  const d = doc.direction;
  if (!d) return '';
  const lead = d.from ? `Direction from ${d.from}.` : `Claude proposed a direction on ${d.date}.`;
  return `${lead} Claude has not changed ${doc.target ? 'it' : `the ${doc.kind}`} yet.`;
}

/** The setDirection that marks the direction accepted at `scope`. */
export function acceptedDirection(doc: Pick<OutlineDoc, 'direction'>, scope: DirectionScope): OutlineOp | undefined {
  const d = doc.direction;
  return d && { op: 'setDirection', direction: { ...d, state: 'accepted', scope } };
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** IPC wraps main's errors. This keeps main's words. */
export const cleanError = (err: unknown) => message(err).replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '');

export const isConflict = (err: unknown) => /changed since/.test(message(err));

/**
 * Writes at `version`, or at a fresh read's version when there is none. A stale version
 * reads the file again and writes the same ops once more. Ops target ids, so they still apply.
 */
export async function writeWithRetry<R>(version: string | undefined, read: () => Promise<string | undefined>, write: (version: string) => Promise<R>): Promise<R> {
  const first = version ?? (await read());
  if (first === undefined) throw new Error('Could not read the outline.');
  try {
    return await write(first);
  } catch (err) {
    if (!isConflict(err)) throw err;
    const fresh = await read();
    if (fresh === undefined) throw err;
    return write(fresh);
  }
}
