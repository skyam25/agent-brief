import { describe, expect, it } from 'vitest';
import { parseFeedback } from './feedback';
import { buildFeedbackGraph, formatFeedbackGraph, relatedOutput, type GraphFile } from './feedback-graph';

const checkout = `# Feedback · checkout.html

## Round 2 · SME · 2026-10-18 · transcripts/sme-2.md
## Round 1 · customers · 2026-10-12 · transcripts/cust-1.md

- [ ] #6 Hard to find the filters
    Round: 1
    Src: 1 · Ana · 03:02 · "Where do I filter?"
    Src: 2 · Maya · 00:14 · "I couldn't find the filters"
    Related: ../pricing/pricing.html #3
    Related: gone.html #1
    Claude: 2026-10-12 · cataloged
    Workspace: 2026-10-18 · saved · fb-checkout-6 · checkout.html.feedback/6-workspace.png
`;

const pricing = `# Feedback · pricing.html

## Round 1 · SME · 2026-10-18 · transcripts/sme-2.md

- [x] #3 Plans hide the filters
    Round: 1
    Claude: 2026-10-18 · done
`;

const old = `# Feedback · old.html

## Round 1 · customers · 2026-10-01

- [ ] #1 A point on a page that is gone
    Round: 1
`;

const files: GraphFile[] = [
  { path: 'proto/checkout.html.feedback.md', output: 'proto/checkout.html', outputExists: true, doc: parseFeedback(checkout) },
  { path: 'old.html.feedback.md', output: 'old.html', outputExists: false, doc: parseFeedback(old) },
  { path: 'pricing/pricing.html.feedback.md', output: 'pricing/pricing.html', outputExists: true, doc: parseFeedback(pricing) },
];

describe('buildFeedbackGraph', () => {
  const graph = buildFeedbackGraph(files);
  const node = (id: string) => graph.nodes.find((n) => n.id === id);
  const edges = (kind: string) => graph.edges.filter((e) => e.kind === kind).map((e) => `${e.from} → ${e.to}`);

  it('links a repeat to every round that raised it, sharing a transcript across outputs', () => {
    expect(edges('raised')).toEqual([
      'source:customers · transcripts/cust-1.md → item:proto/checkout.html#6',
      'source:SME · transcripts/sme-2.md → item:proto/checkout.html#6',
      'source:old.html.feedback.md#1 → item:old.html#1',
      'source:SME · transcripts/sme-2.md → item:pricing/pricing.html#3',
    ]);
    expect(node('source:SME · transcripts/sme-2.md')).toMatchObject({
      kind: 'source',
      label: 'SME · sme-2.md',
      detail: 'transcripts/sme-2.md\nproto/checkout.html round 2 · 2026-10-18\npricing/pricing.html round 1 · 2026-10-18',
    });
    expect(node('source:old.html.feedback.md#1')).toMatchObject({ label: 'Round 1 · customers' });
  });

  it('resolves Related across outputs and marks targets no file holds', () => {
    expect(edges('related')).toEqual(['item:proto/checkout.html#6 → item:pricing/pricing.html#3', 'item:proto/checkout.html#6 → item:proto/gone.html#1']);
    expect(node('item:pricing/pricing.html#3')).toMatchObject({ label: '#3 Plans hide the filters', state: 'done', n: 3, output: 'pricing/pricing.html' });
    expect(node('item:proto/gone.html#1')).toMatchObject({ missing: true, label: '#1' });
  });

  it('marks a missing output and links items to outputs and workspaces', () => {
    expect(node('output:old.html')).toMatchObject({ kind: 'output', label: 'old.html', missing: true });
    expect(node('output:proto/checkout.html')?.missing).toBeUndefined();
    expect(edges('about')).toEqual(['item:proto/checkout.html#6 → output:proto/checkout.html', 'item:old.html#1 → output:old.html', 'item:pricing/pricing.html#3 → output:pricing/pricing.html']);
    expect(edges('worked in')).toEqual(['item:proto/checkout.html#6 → workspace:fb-checkout-6']);
    expect(graph.nodes.filter((n) => n.kind === 'workspace').map((n) => n.label)).toEqual(['fb-checkout-6']);
  });

  it('reads as text by output', () => {
    expect(formatFeedbackGraph(graph)).toBe(`3 sources · 4 items · 3 outputs · 1 workspace

proto/checkout.html
  #6 [open] Hard to find the filters
    raised by customers · cust-1.md, SME · sme-2.md
    related → pricing/pricing.html #3, → proto/gone.html #1 (not found)
    worked in fb-checkout-6

old.html (output missing)
  #1 [open] A point on a page that is gone
    raised by Round 1 · customers

pricing/pricing.html
  #3 [done] Plans hide the filters
    raised by SME · sme-2.md
    related ← proto/checkout.html #6`);
    expect(formatFeedbackGraph({ nodes: [], edges: [] })).toBe('no feedback files in this project');
  });
});

describe('relatedOutput', () => {
  it('resolves from the feedback file folder', () => {
    expect(relatedOutput('proto/checkout.html', 'pricing.html')).toBe('proto/pricing.html');
    expect(relatedOutput('proto/checkout.html', '../pricing/./pricing.html')).toBe('pricing/pricing.html');
    expect(relatedOutput('checkout.html', '../up.html')).toBe('../up.html');
  });
});
