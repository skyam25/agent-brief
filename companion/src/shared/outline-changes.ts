/**
 * What Claude changed in an outline since you last looked. Rows keep their ids across edits,
 * so two versions compare row by row: points, sections, sources and intent lines.
 */

import type { OutlineCite, OutlineDoc, OutlinePoint, OutlineSource } from '../protocol';

export type RowChangeKind = 'added' | 'edited' | 'removed';

export interface OutlineRowChange {
  /** A point `p3`, a section `s1`, a source `S2`, or an intent line `intent:Goal`. */
  id: string;
  row: 'point' | 'section' | 'source' | 'intent';
  change: RowChangeKind;
  /** What the row said before: the old wording of each field that changed, or of the whole row when removed. */
  was: string[];
  /** For a removed point, its section. For a removed point or section, the row it followed, or null when first. */
  section?: string;
  after?: string | null;
}

export interface OutlineChanges {
  /** ISO time of Claude's latest change. */
  at: string;
  rows: OutlineRowChange[];
}

const citesText = (cites: OutlineCite[]) => cites.map((c) => [c.source, c.location, c.mark].filter(Boolean).join(' · ')).join(', ');

/** The old wording of each point field that changed. */
function pointWas(before: OutlinePoint, after: OutlinePoint): string[] {
  const was: string[] = [];
  if (before.text !== after.text) was.push(before.text);
  if (before.kind !== after.kind) was.push(before.kind === 'open' ? 'An open question' : 'A point');
  if ((before.guide ?? '') !== (after.guide ?? '')) was.push(`Guide · ${before.guide || 'none'}`);
  if ((before.keep ?? '') !== (after.keep ?? '')) was.push(`Keep · ${before.keep || 'none'}`);
  if ((before.default ?? '') !== (after.default ?? '')) was.push(`Default · ${before.default || 'none'}`);
  if (citesText(before.cites) !== citesText(after.cites)) was.push(`Cites · ${citesText(before.cites) || 'none'}`);
  return was;
}

function sourceWas(before: OutlineSource, after: OutlineSource): string[] {
  const was: string[] = [];
  if (before.title !== after.title) was.push(before.title);
  if ((before.ref ?? '') !== (after.ref ?? '')) was.push(`Ref · ${before.ref || 'none'}`);
  if ((before.supports ?? '') !== (after.supports ?? '')) was.push(`Supports · ${before.supports || 'none'}`);
  if ((before.notShown ?? '') !== (after.notShown ?? '')) was.push(`Not shown · ${before.notShown || 'none'}`);
  return was;
}

/**
 * Every row that differs between `before` and `after`, in the order `after` shows them, removed rows last.
 * A `reused` id was removed and then given to a new row, so it counts as both.
 */
export function outlineRowChanges(before: OutlineDoc, after: OutlineDoc, reused: ReadonlySet<string> = new Set()): OutlineRowChange[] {
  const changes: OutlineRowChange[] = [];
  const kept = <T extends { id: string }>(rows: T[]) => rows.filter((r) => !reused.has(r.id));

  const oldIntent = new Map(before.intent.map((l) => [l.key, l.text]));
  const newIntent = new Map(after.intent.map((l) => [l.key, l.text]));
  for (const l of after.intent) {
    const old = oldIntent.get(l.key);
    if (old === undefined) changes.push({ id: `intent:${l.key}`, row: 'intent', change: 'added', was: [] });
    else if (old !== l.text) changes.push({ id: `intent:${l.key}`, row: 'intent', change: 'edited', was: [old] });
  }

  const oldSections = new Map(kept(before.sections).map((s) => [s.id, s]));
  const oldPoints = new Map(kept(before.sections.flatMap((s) => s.points)).map((p) => [p.id, p]));
  const newPoints = new Set(kept(after.sections.flatMap((s) => s.points)).map((p) => p.id));
  for (const s of after.sections) {
    const old = oldSections.get(s.id);
    if (!old) changes.push({ id: s.id, row: 'section', change: 'added', was: [] });
    else if (old.title !== s.title) changes.push({ id: s.id, row: 'section', change: 'edited', was: [old.title] });
    for (const p of s.points) {
      const prior = oldPoints.get(p.id);
      if (!prior) changes.push({ id: p.id, row: 'point', change: 'added', was: [] });
      else {
        const was = pointWas(prior, p);
        if (was.length) changes.push({ id: p.id, row: 'point', change: 'edited', was });
      }
    }
  }

  const oldSources = new Map(kept(before.sources).map((s) => [s.id, s]));
  for (const s of after.sources) {
    const old = oldSources.get(s.id);
    if (!old) changes.push({ id: s.id, row: 'source', change: 'added', was: [] });
    else {
      const was = sourceWas(old, s);
      if (was.length) changes.push({ id: s.id, row: 'source', change: 'edited', was });
    }
  }

  for (const l of before.intent) if (!newIntent.has(l.key)) changes.push({ id: `intent:${l.key}`, row: 'intent', change: 'removed', was: [l.text] });
  const newSections = new Set(kept(after.sections).map((s) => s.id));
  before.sections.forEach((s, i) => {
    if (!newSections.has(s.id)) changes.push({ id: s.id, row: 'section', change: 'removed', was: [s.title], after: before.sections[i - 1]?.id ?? null });
    s.points.forEach((p, j) => {
      if (!newPoints.has(p.id)) changes.push({ id: p.id, row: 'point', change: 'removed', was: [p.text], section: s.id, after: s.points[j - 1]?.id ?? null });
    });
  });
  const newSources = new Set(kept(after.sources).map((s) => s.id));
  for (const s of before.sources) if (!newSources.has(s.id)) changes.push({ id: s.id, row: 'source', change: 'removed', was: [s.title] });
  return changes;
}

/** True when an outline has no sections, so Claude's next write is its first draft. */
export const isBlankOutline = (doc: OutlineDoc) => doc.sections.length === 0;
