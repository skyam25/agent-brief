/**
 * The project graph of feedback: sources (rounds), items, outputs and workspaces,
 * built from the parsed feedback files alone.
 */

import type { FeedbackDoc, FeedbackGraph, FeedbackGraphEdge, FeedbackGraphNode, FeedbackRound } from '../protocol';

export interface GraphFile {
  /** The feedback file, relative to the project. */
  path: string;
  output: string;
  outputExists: boolean;
  doc: FeedbackDoc;
}

/** A `Related:` path is relative to the feedback file's folder. Gives the output relative to the project. */
export function relatedOutput(from: string, rel: string): string {
  const parts = from.split('/').slice(0, -1);
  for (const p of rel.split('/')) {
    if (p === '' || p === '.') continue;
    if (p === '..' && parts.length && parts.at(-1) !== '..') parts.pop();
    else parts.push(p);
  }
  return parts.join('/') || '.';
}

const baseName = (p: string) => p.split('/').filter(Boolean).at(-1) ?? p;

export const itemId = (output: string, n: number) => `item:${output}#${n}`;
export const outputId = (output: string) => `output:${output}`;

/** Rounds with a source share one node across outputs. Rounds without one stay with their file. */
function sourceKey(file: GraphFile, r: FeedbackRound) {
  return r.source ? `source:${r.label} · ${r.source}` : `source:${file.path}#${r.n}`;
}

/** Workspace lines read `<date> · <verb> · <board> · …`. */
const workspaceBoard = (detail: string) => detail.split(' · ')[0]?.trim() ?? '';

export function buildFeedbackGraph(files: GraphFile[]): FeedbackGraph {
  const nodes = new Map<string, FeedbackGraphNode>();
  const edges: FeedbackGraphEdge[] = [];
  const seen = new Set<string>();
  /** Each source's transcript, then the rounds that used it. */
  const rounds = new Map<string, Set<string>>();
  const edge = (from: string, to: string, kind: FeedbackGraphEdge['kind']) => {
    const key = `${from}\n${to}\n${kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ from, to, kind });
  };
  const add = (node: FeedbackGraphNode) => {
    if (!nodes.has(node.id)) nodes.set(node.id, node);
    return nodes.get(node.id)!;
  };

  for (const file of files) {
    const out = add({ id: outputId(file.output), kind: 'output', label: baseName(file.output), output: file.output, detail: file.output, ...(file.outputExists ? {} : { missing: true }) });
    for (const item of file.doc.items) {
      const id = itemId(file.output, item.n);
      add({ id, kind: 'item', label: `#${item.n} ${item.title}`, output: file.output, n: item.n, state: item.state, detail: `${file.output} #${item.n} ${item.title}` });
      for (const n of item.rounds) {
        const r = file.doc.rounds.find((x) => x.n === n);
        if (!r) continue;
        const key = sourceKey(file, r);
        add({ id: key, kind: 'source', label: r.source ? `${r.label} · ${baseName(r.source)}` : `Round ${r.n} · ${r.label}` });
        const used = rounds.get(key) ?? new Set(r.source ? [r.source] : []);
        used.add(`${file.output} round ${r.n} · ${r.date}`);
        rounds.set(key, used);
        edge(key, id, 'raised');
      }
      edge(id, out.id, 'about');
      for (const e of item.events) {
        if (e.key !== 'Workspace') continue;
        const board = workspaceBoard(e.detail);
        if (!board) continue;
        add({ id: `workspace:${board}`, kind: 'workspace', label: board });
        edge(id, `workspace:${board}`, 'worked in');
      }
    }
  }

  // Related lines resolve once every file's items are in, so links run both ways across outputs.
  for (const file of files) {
    for (const item of file.doc.items) {
      for (const r of item.related) {
        const target = relatedOutput(file.output, r.path);
        const id = itemId(target, r.n);
        if (!nodes.has(id)) add({ id, kind: 'item', label: `#${r.n}`, output: target, n: r.n, missing: true, detail: `${target} #${r.n} (no feedback file holds it)` });
        edge(itemId(file.output, item.n), id, 'related');
      }
    }
  }
  for (const [key, used] of rounds) nodes.get(key)!.detail = [...used].join('\n');
  return { nodes: [...nodes.values()], edges };
}

/** The graph as text for `agent-brief feedback graph`, by output. */
export function formatFeedbackGraph(graph: FeedbackGraph): string {
  const count = (kind: FeedbackGraphNode['kind'], one: string) => {
    const n = graph.nodes.filter((x) => x.kind === kind).length;
    return `${n} ${one}${n === 1 ? '' : 's'}`;
  };
  if (!graph.nodes.length) return 'no feedback files in this project';
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const from = (id: string, kind: FeedbackGraphEdge['kind']) => graph.edges.filter((e) => e.from === id && e.kind === kind).map((e) => byId.get(e.to)!);
  const to = (id: string, kind: FeedbackGraphEdge['kind']) => graph.edges.filter((e) => e.to === id && e.kind === kind).map((e) => byId.get(e.from)!);
  const itemName = (n: FeedbackGraphNode) => `${n.output} #${n.n}${n.missing ? ' (not found)' : ''}`;
  const lines = [[count('source', 'source'), count('item', 'item'), count('output', 'output'), count('workspace', 'workspace')].join(' · ')];
  for (const out of graph.nodes.filter((n) => n.kind === 'output')) {
    lines.push('', `${out.output}${out.missing ? ' (output missing)' : ''}`);
    for (const item of to(out.id, 'about')) {
      lines.push(`  ${item.label.replace(/^#(\d+)/, `#$1 [${item.state}]`)}`);
      const raised = to(item.id, 'raised');
      if (raised.length) lines.push(`    raised by ${raised.map((s) => s.label).join(', ')}`);
      const related = [...from(item.id, 'related').map((n) => `→ ${itemName(n)}`), ...to(item.id, 'related').map((n) => `← ${itemName(n)}`)];
      if (related.length) lines.push(`    related ${related.join(', ')}`);
      const work = from(item.id, 'worked in');
      if (work.length) lines.push(`    worked in ${work.map((w) => w.label).join(', ')}`);
    }
  }
  return lines.join('\n');
}
