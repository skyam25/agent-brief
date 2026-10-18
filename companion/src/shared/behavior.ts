import type { BehaviorDocument, BehaviorRule, BehaviorSpec } from '../protocol';

export const behaviorPath = (html: string) => `${html}.behavior.json`;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const string = (v: unknown, max = 4000): v is string => typeof v === 'string' && !!v.trim() && v.length <= max;

/** Reject invalid specifications rather than silently losing decisions. */
export function validRule(v: unknown): v is BehaviorRule {
  if (!object(v) || !string(v.id, 100) || !/^[\w-]+$/.test(v.id) || !string(v.text)) return false;
  if (v.status !== 'proposed' && v.status !== 'confirmed') return false;
  if (!object(v.source) || !['brief', 'comment', 'decision', 'assumption'].includes(String(v.source.kind)) || !string(v.source.ref)) return false;
  if (v.status === 'confirmed' && v.source.kind === 'assumption') return false;
  if (!['planned', 'implemented', 'verified'].includes(String(v.delivery))) return false;
  if (v.delivery !== 'planned' && v.status !== 'confirmed') return false;
  if (v.delivery === 'verified' && !string(v.evidence)) return false;
  if (v.evidence !== undefined && !string(v.evidence)) return false;
  if (v.note !== undefined && (typeof v.note !== 'string' || v.note.length > 4000)) return false;
  return v.target === undefined || (object(v.target) && string(v.target.selector, 2000) && (v.target.state === undefined || string(v.target.state, 1000)));
}

export const validLimitations = (v: unknown): v is string[] => Array.isArray(v) && v.length <= 100 && v.every((s) => string(s));
export const validRules = (v: unknown): v is BehaviorRule[] => Array.isArray(v) && v.length <= 300 && v.every(validRule) && new Set(v.map((r) => r.id)).size === v.length;

export function parseBehavior(text: string): BehaviorSpec {
  const v: unknown = JSON.parse(text);
  if (!object(v) || v.schema !== 1 || !Number.isSafeInteger(v.revision) || Number(v.revision) < 0 || !validRules(v.rules) || !validLimitations(v.limitations) || !Array.isArray(v.history) || v.history.length > 100) throw new Error('Invalid behavior specification');
  for (const h of v.history) {
    if (!object(h) || !Number.isSafeInteger(h.revision) || !string(h.at) || !string(h.by) || !validRules(h.before) || !validRules(h.after) || !validLimitations(h.limitationsBefore) || !validLimitations(h.limitationsAfter)) throw new Error('Invalid behavior history');
  }
  return v as unknown as BehaviorSpec;
}

/** Human-readable handoff, generated from the canonical specification. */
export function behaviorMarkdown(doc: BehaviorDocument): string {
  const lines = ['## Behavior', '', `Specification: ${doc.path} (revision ${doc.revision})`, '', 'Confirmed means agreed, not implemented. Read the current specification before updating it.'];
  for (const [status, heading] of [['confirmed', 'Confirmed acceptance criteria'], ['proposed', 'Open assumptions']] as const) {
    lines.push('', `### ${heading}`, '');
    const rules = doc.rules.filter((r) => r.status === status);
    if (!rules.length) lines.push('(none)');
    for (const r of rules) {
      lines.push(`- [${r.id}] ${r.text}`, `  Source (${r.source.kind}): ${r.source.ref}`, `  Delivery: ${r.delivery}`);
      if (r.target) lines.push(`  Element: ${r.target.selector}${r.target.state ? `; state: ${r.target.state}` : ''}`);
      if (r.note) lines.push(`  Question / note: ${r.note}`);
      if (r.evidence) lines.push(`  Evidence: ${r.evidence}`);
    }
  }
  lines.push('', '### Prototype limitations', '', ...(doc.limitations.length ? doc.limitations.map((s) => `- ${s}`) : ['(none recorded)']));
  return lines.join('\n');
}
