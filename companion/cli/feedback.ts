/** Text views for `agent-brief feedback`. */

import type { FeedbackDocument, FeedbackItem, FeedbackProject, FeedbackRound } from '../src/protocol';
import { feedbackItemText, relatedCandidates } from '../src/shared/feedback';
import type { FeedbackWorkspace } from '../src/protocol';
import { frameTitle } from '../src/shared/feedback-workspace';
import { relatedOutput } from '../src/shared/feedback-graph';

export { relatedOutput };

const roundsOf = (item: FeedbackItem) => {
  const [first, ...later] = item.rounds;
  if (first === undefined) return '';
  return later.length ? ` · round ${first}, also ${later.join(', ')}` : ` · round ${first}`;
};

export const itemHead = (item: FeedbackItem) => `#${item.n} [${item.state}] ${item.title}${roundsOf(item)}`;

/** `customers · 2026-10-12 · transcripts/cust-1.md`. */
export const roundText = (r: FeedbackRound) => [r.label, r.date, ...(r.source ? [r.source] : [])].join(' · ');

export function formatFeedback(doc: FeedbackDocument): string {
  if (doc.version === 'missing') return `${doc.path} · no feedback yet. Add a round with "agent-brief feedback round".`;
  const lines = [`${doc.path} · version ${doc.version}`];
  for (const r of doc.rounds) lines.push(`Round ${r.n} · ${roundText(r)}`);
  for (const item of doc.items) {
    lines.push('', itemHead(item));
    for (const l of item.lines) if (l.key !== 'Round') lines.push(`    ${l.key ? `${l.key}: ` : ''}${l.text}`);
  }
  return lines.join('\n');
}

export function formatProject(project: FeedbackProject): string {
  if (!project.files.length) return 'no feedback files in this project';
  const lines = project.files.map((f) =>
    `${f.output}${f.outputExists ? '' : ' (output missing)'} · ${f.open} open · ${f.accepted} accepted · ${f.rejected} rejected · ${f.done} done · ${f.rounds} round${f.rounds === 1 ? '' : 's'}`,
  );
  if (project.truncated) lines.push('(the scan stopped early; some files are not listed)');
  return lines.join('\n');
}

export interface RelatedView {
  item?: FeedbackItem;
  links: { way: 'to' | 'from'; output: string; n: number; item?: FeedbackItem }[];
  similar: { output: string; item: FeedbackItem; shared: string[] }[];
}

/** An item's `Related:` links both ways and the items that look like it, or the items that look like `text`. */
export function relatedView(docs: FeedbackDocument[], output: string, query: { n?: number; text?: string }): RelatedView {
  const find = (out: string, n: number) => docs.find((d) => d.output === out)?.items.find((i) => i.n === n);
  if (query.n === undefined) return { links: [], similar: relatedCandidates(docs, query.text ?? '') };
  const item = find(output, query.n);
  if (!item) return { links: [], similar: [] };
  const links: RelatedView['links'] = item.related.map((r) => {
    const out = relatedOutput(output, r.path);
    return { way: 'to', output: out, n: r.n, item: find(out, r.n) };
  });
  for (const doc of docs) {
    for (const other of doc.items) {
      if (other.related.some((r) => relatedOutput(doc.output, r.path) === output && r.n === item.n)) links.push({ way: 'from', output: doc.output, n: other.n, item: other });
    }
  }
  const linked = new Set(links.map((l) => `${l.output}#${l.n}`));
  const similar = relatedCandidates(docs, feedbackItemText(item), { output, n: item.n }).filter((h) => !linked.has(`${h.output}#${h.item.n}`));
  return { item, links, similar };
}

export function formatRelated(view: RelatedView, output: string): string {
  const lines: string[] = [];
  if (view.item) {
    lines.push(`${output} ${itemHead(view.item)}`);
    if (view.links.length) {
      lines.push('Linked:');
      for (const l of view.links) lines.push(`  ${l.way === 'to' ? '→' : '←'} ${l.output} ${l.item ? itemHead(l.item) : `#${l.n} (not found)`}`);
    }
  }
  lines.push(view.similar.length ? 'Similar:' : 'No similar items.');
  for (const h of view.similar) lines.push(`  ${h.output} ${itemHead(h.item)} · shares ${h.shared.join(', ')}`);
  return lines.join('\n');
}

/** Look-alikes for several points, each under its point. */
export function formatSimilar(views: { text: string; similar: RelatedView['similar'] }[]): string {
  const lines: string[] = [];
  for (const v of views) {
    lines.push(JSON.stringify(v.text));
    if (!v.similar.length) lines.push('  no similar items');
    for (const h of v.similar) lines.push(`  ${h.output} ${itemHead(h.item)} · shares ${h.shared.join(', ')}`);
  }
  return lines.join('\n');
}

/** One point of a `feedback catalog` file: a new item, or `same` to join an item the file has. */
export interface CatalogEntry {
  title?: string;
  same?: number;
  src: string[];
  change?: string;
  where?: string;
  options: string[];
  related: string[];
}

export type CatalogResult =
  | { kind: 'added'; n: number; item?: FeedbackItem; like: RelatedView['similar'] }
  | { kind: 'joined'; n: number; item?: FeedbackItem }
  | { kind: 'skipped'; title?: string; n: number; why: 'has it' | 'has these quotes' };

/** Reads a catalog file: a list of points, or `{ "items": [...] }`. Throws a message naming the bad point. */
export function catalogEntries(json: unknown): CatalogEntry[] {
  const list = Array.isArray(json) ? json : (json as { items?: unknown } | null)?.items;
  if (!Array.isArray(list) || !list.length) throw new Error('--items is a JSON list of points, such as [{"title": "…", "src": ["Ana · 03:02 · \\"…\\""]}]');
  return list.map((raw, i) => {
    const at = `item ${i + 1}`;
    if (!raw || typeof raw !== 'object') throw new Error(`${at} is not an object`);
    const e = raw as Record<string, unknown>;
    const text = (k: string) => {
      if (e[k] === undefined) return undefined;
      if (typeof e[k] !== 'string') throw new Error(`${at}: ${k} is text`);
      return e[k] as string;
    };
    const texts = (k: string) => {
      const v = e[k] === undefined ? [] : typeof e[k] === 'string' ? [e[k]] : e[k];
      if (!Array.isArray(v) || v.some((s) => typeof s !== 'string')) throw new Error(`${at}: ${k} is text or a list of text`);
      return v as string[];
    };
    const same = e.same;
    if (same !== undefined && !(Number.isInteger(same) && (same as number) > 0)) throw new Error(`${at}: same is an item number`);
    const title = text('title');
    if (!title?.trim() && same === undefined) throw new Error(`${at} needs a title, or "same" with the number of the item it repeats`);
    return { title, same: same as number | undefined, src: texts('src'), change: text('change'), where: text('where'), options: texts('options'), related: texts('related') };
  });
}

export function formatCatalog(round: { round: FeedbackRound; existed: boolean; path: string }, results: CatalogResult[]): string {
  const lines = [round.existed ? `round ${round.round.n} already exists in ${round.path} · ${roundText(round.round)}` : `added round ${round.round.n} · ${roundText(round.round)} to ${round.path}`];
  for (const r of results) {
    if (r.kind === 'skipped') lines.push(r.title === undefined ? `skipped #${r.n}: it ${r.why}` : `skipped ${JSON.stringify(r.title)}: #${r.n} ${r.why}`);
    else lines.push(`${r.kind} ${r.item ? itemHead(r.item) : `#${r.n}`}`);
    if (r.kind === 'added') for (const h of r.like) lines.push(`  looks like ${h.output} ${itemHead(h.item)} · shares ${h.shared.join(', ')}`);
  }
  return lines.join('\n');
}

/** The board name first, so a script can take the first line. */
export function formatWorkspace(ws: FeedbackWorkspace): string {
  const what = ws.created ? `new board with a ${frameTitle(ws.round)} frame` : ws.framed ? `added a ${frameTitle(ws.round)} frame` : `${frameTitle(ws.round)} frame is there`;
  return `${ws.board}\n${what}. Draw with: agent-brief draw --board ${ws.board}`;
}
