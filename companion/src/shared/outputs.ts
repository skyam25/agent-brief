/** Reads a session's outputs file and orders its records for the panel. */

import type { OutputRecord, OutputsFile } from '../protocol';

const KINDS = new Set(['markdown', 'html', 'pdf', 'docx', 'pptx', 'xlsx', 'artifact', 'other']);
const TIERS = new Set(['declared', 'detected']);
const STATUSES = new Set(['drafting', 'ready']);
const ORIGINS = new Set(['created', 'edited']);

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : undefined);

/** Keeps the well-formed fields of one record, or drops it when `ref`, `kind` or `tier` is missing. */
export function cleanOutput(raw: unknown): OutputRecord | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const ref = str(r.ref);
  const kind = str(r.kind);
  const tier = str(r.tier);
  if (!ref || !kind || !KINDS.has(kind) || !tier || !TIERS.has(tier)) return undefined;
  const status = str(r.status);
  const origin = str(r.origin);
  return {
    ref,
    kind: kind as OutputRecord['kind'],
    tier: tier as OutputRecord['tier'],
    ...(str(r.url) ? { url: r.url as string } : {}),
    ...(str(r.title) ? { title: (r.title as string).trim() } : {}),
    ...(status && STATUSES.has(status) ? { status: status as OutputRecord['status'] } : {}),
    ...(origin && ORIGINS.has(origin) ? { origin: origin as OutputRecord['origin'] } : {}),
    ...(num(r.declaredAt) !== undefined ? { declaredAt: r.declaredAt as number } : {}),
    ...(num(r.firstWriteAt) !== undefined ? { firstWriteAt: r.firstWriteAt as number } : {}),
    ...(num(r.lastWriteAt) !== undefined ? { lastWriteAt: r.lastWriteAt as number } : {}),
    ...(num(r.writes) !== undefined ? { writes: r.writes as number } : {}),
  };
}

/** Parses the file's JSON. Undefined for anything but a version 1 file with an outputs list. */
export function parseOutputsFile(text: string): OutputsFile | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof raw !== 'object' || raw === null) return undefined;
  const f = raw as Record<string, unknown>;
  if (f.version !== 1 || !Array.isArray(f.outputs)) return undefined;
  const seen = new Set<string>();
  const outputs: OutputRecord[] = [];
  for (const item of f.outputs) {
    const rec = cleanOutput(item);
    if (rec && !seen.has(rec.ref)) {
      seen.add(rec.ref);
      outputs.push(rec);
    }
  }
  return { version: 1, sessionId: str(f.sessionId) ?? '', outputs };
}

/** When the record last moved: its declaration or its latest write, whichever is later. */
export function outputTouchedAt(r: OutputRecord): number {
  return Math.max(r.declaredAt ?? 0, r.lastWriteAt ?? 0);
}

/** Declared records first, then detected, each newest on top. */
export function sortOutputs(records: readonly OutputRecord[]): OutputRecord[] {
  const rank = (r: OutputRecord) => (r.tier === 'declared' ? 0 : 1);
  return [...records].sort((a, b) => rank(a) - rank(b) || outputTouchedAt(b) - outputTouchedAt(a) || a.ref.localeCompare(b.ref));
}

/** The row's label: the title, else the file name, else the URL. */
export function outputLabel(r: OutputRecord): string {
  if (r.title) return r.title;
  if (r.url) return r.url;
  return r.ref.split('/').filter(Boolean).at(-1) ?? r.ref;
}

export const isUrlRef = (ref: string): boolean => /^https?:\/\//i.test(ref);

/**
 * What Review mode opens on: the newest review with comments or a note, else the
 * newest Ready HTML output. Nothing while an item waits on you, so its question stays in view.
 */
export function reviewStart(opts: {
  reviews: readonly { id: string; updatedAt: number; hasContent: boolean }[];
  outputs: readonly OutputRecord[];
  itemWaits: boolean;
}): { draftId: string } | { ref: string } | undefined {
  if (opts.itemWaits) return undefined;
  const review = opts.reviews.filter((r) => r.hasContent).sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (review) return { draftId: review.id };
  const page = opts.outputs
    .filter((r) => r.tier === 'declared' && r.kind === 'html' && r.status === 'ready')
    .sort((a, b) => outputTouchedAt(b) - outputTouchedAt(a))[0];
  return page ? { ref: page.ref } : undefined;
}
