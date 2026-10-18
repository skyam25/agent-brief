/** Text views for `agent-brief feedback`. */

import path from 'node:path';
import type { FeedbackDocument, FeedbackItem, FeedbackProject } from '../src/protocol';
import { feedbackItemText, relatedCandidates } from '../src/shared/feedback';
import type { FeedbackWorkspace } from '../src/protocol';
import { frameTitle } from '../src/shared/feedback-workspace';

const roundsOf = (item: FeedbackItem) => {
  const [first, ...later] = item.rounds;
  if (first === undefined) return '';
  return later.length ? ` · round ${first}, also ${later.join(', ')}` : ` · round ${first}`;
};

export const itemHead = (item: FeedbackItem) => `#${item.n} [${item.state}] ${item.title}${roundsOf(item)}`;

export function formatFeedback(doc: FeedbackDocument): string {
  if (doc.version === 'missing') return `${doc.path} · no feedback yet. Add a round with "agent-brief feedback round".`;
  const lines = [`${doc.path} · version ${doc.version}`];
  for (const r of doc.rounds) lines.push(`Round ${r.n} · ${r.label} · ${r.date}${r.source ? ` · ${r.source}` : ''}`);
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

/** A `Related:` path is relative to the feedback file's folder. */
export const relatedOutput = (from: string, rel: string) => path.posix.normalize(path.posix.join(path.posix.dirname(from), rel));

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

/** The board name first, so a script can take the first line. */
export function formatWorkspace(ws: FeedbackWorkspace): string {
  const what = ws.created ? `new board with a ${frameTitle(ws.round)} frame` : ws.framed ? `added a ${frameTitle(ws.round)} frame` : `${frameTitle(ws.round)} frame is there`;
  return `${ws.board}\n${what}. Draw with: agent-brief draw --board ${ws.board}`;
}
