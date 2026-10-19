import { describe, expect, it } from 'vitest';
import { applyFeedbackOps, decisionsPrompt, parseFeedback, pendingDecisions, receiptBatches } from './feedback';

const HEAD = `# Feedback · checkout.html

## Round 1 · customers · 2026-10-12 · transcripts/cust-1.md
`;

const item = (n: number, ...lines: string[]) => `\n- [ ] #${n} Item ${n}\n    Round: 1\n    Claude: 2026-10-12 · cataloged\n${lines.map((l) => `    ${l}\n`).join('')}`;

const as = (by: 'Claude' | 'You') => (text: string, ops: unknown[]) => applyFeedbackOps(text, { output: 'site/checkout.html', ops, by, date: '2026-10-21' }).text;
const you = as('You');
const doc = (text: string) => ({ ...parseFeedback(text), path: 'site/checkout.html.feedback.md', output: 'site/checkout.html', version: 'v' });

describe('Send decisions', () => {
  it('counts a saved workspace as a response and points Claude at its picture and board', () => {
    const text = HEAD + item(1, 'Workspace: 2026-10-18 · saved · fb-checkout-1 · checkout.html.feedback/1-workspace-a1.png');
    const pending = pendingDecisions(doc(text));
    expect(pending.map((p) => [p.item.n, p.said.length, p.saved.length, p.through])).toEqual([[1, 0, 1, 2]]);
    const message = decisionsPrompt(doc(text), pending);
    expect(message).toContain('- #1 Item 1: saved a workspace');
    expect(message).toContain('  Saved workspace: board fb-checkout-1, picture site/checkout.html.feedback/1-workspace-a1.png');
    expect(message).toMatch(/look at each saved workspace's picture.*agent-brief read --board/i);
  });

  it('takes a Save with its pin and overall notes as one pending response', () => {
    const text = HEAD + item(1, 'You: 2026-10-18 · note · pin 1 on rectangle “Filters” · make it sticky', 'You: 2026-10-18 · note · keep sort on the right', 'Workspace: 2026-10-18 · saved · fb-checkout-1 · checkout.html.feedback/1-workspace-1.png');
    const pending = pendingDecisions(doc(text));
    expect(pending.map((p) => [p.said.length, p.saved.length, p.through])).toEqual([[2, 1, 4]]);
    expect(decisionsPrompt(doc(text), pending).split('\n').slice(2, 4)).toEqual([
      '- #1 Item 1: note · pin 1 on rectangle “Filters” · make it sticky; note · keep sort on the right',
      '  Saved workspace: board fb-checkout-1, picture site/checkout.html.feedback/1-workspace-1.png',
    ]);
  });

  it('records a receipt through the last event sent, so later events stay pending', () => {
    const start = HEAD + item(1, 'You: 2026-10-18 · accept');
    const snapshot = pendingDecisions(doc(start));
    expect(snapshot[0]!.through).toBe(2);

    // Another writer adds a note while the send is out, then the receipt lands.
    const raced = you(start, [{ op: 'append', item: 1, key: 'You', text: 'note · also on mobile' }]);
    const marked = receiptBatches(snapshot).reduce(you, raced);
    expect(marked).toContain('    You: 2026-10-21 · sent · through 2\n');
    const left = pendingDecisions(doc(marked));
    expect(left.map((p) => p.said.map((e) => `${e.verb} · ${e.detail}`))).toEqual([['note · also on mobile']]);

    // A save after a send is pending again, and its own send clears it.
    const saved = you(marked, [{ op: 'append', item: 1, key: 'Workspace', text: 'saved · fb-checkout-1 · checkout.html.feedback/1-workspace-b2.png' }]);
    const again = pendingDecisions(doc(saved));
    expect(again[0]!.saved.map((e) => e.detail)).toEqual(['fb-checkout-1 · checkout.html.feedback/1-workspace-b2.png']);
    expect(pendingDecisions(doc(receiptBatches(again).reduce(you, saved)))).toEqual([]);
  });

  it('reads a receipt without through as covering every event before it', () => {
    const text = HEAD + item(1, 'You: 2026-10-18 · accept', 'You: 2026-10-18 · sent', 'You: 2026-10-19 · note · later');
    expect(pendingDecisions(doc(text)).map((p) => p.said.map((e) => e.verb))).toEqual([['note']]);
  });

  it('writes receipts for more items than one update holds in bounded batches', () => {
    let text = HEAD;
    for (let n = 1; n <= 201; n++) text += item(n, 'You: 2026-10-18 · accept');
    const pending = pendingDecisions(doc(text));
    expect(pending).toHaveLength(201);
    const batches = receiptBatches(pending);
    expect(batches.map((b) => b.length)).toEqual([200, 1]);
    expect(pendingDecisions(doc(batches.reduce(you, text)))).toEqual([]);
  });

  it('names the chosen option and its text', () => {
    const text = HEAD + item(1, 'You: 2026-10-18 · accept · option B · keep it short');
    const parsed = doc(text);
    // The parser fills these from Option: lines; set here so the prompt is tested alone.
    parsed.items[0]!.options = [{ key: 'A', text: 'Hide the box' }, { key: 'B', text: 'Keep the box and explain it' }];
    parsed.items[0]!.chosen = 'B';
    expect(decisionsPrompt(parsed, pendingDecisions(parsed)).split('\n')[2]).toBe('- #1 Item 1: accept · option B (Keep the box and explain it) · keep it short');
  });
});
