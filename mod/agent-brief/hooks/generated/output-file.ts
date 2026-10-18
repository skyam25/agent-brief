// Generated from companion/src/shared/output-file.ts. Run pnpm sync:plugin in companion; do not edit.
/** Canonical reader for the outputs file shared with the standalone plugin. */

import type { OutputRecord, OutputsFile } from '../companion-protocol';

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
