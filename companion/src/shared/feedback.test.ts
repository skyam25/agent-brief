import { describe, expect, it } from 'vitest';
import { applyFeedbackOps, decisionsPrompt, parseFeedback, pendingDecisions, relatedCandidates, serializeFeedback } from './feedback';

const SAMPLE = `# Feedback · checkout.html

## Round 2 · SME · 2026-10-18 · transcripts/sme-2.md
## Round 1 · customers · 2026-10-12 · transcripts/cust-1.md

- [ ] #6 Hard to find the filters
    Round: 1
    Src: 1 · Ana · 03:02 · "Where do I filter?"
    Src: 2 · Maya · 00:14 · "I couldn't find the filters"
    Change: Move the filter row above the results. Sort stays on the right.
    Where: #filters
    Related: pricing.html #3
    Claude: 2026-10-12 · cataloged
    You: 2026-10-12 · accept · keep it sticky on scroll
    Claude: 2026-10-12 · done · commit 3f2a91c
    Before: checkout.html.feedback/6-r1-before.png
    After: checkout.html.feedback/6-r1-after.png
    You: 2026-10-18 · reopen · too long on mobile
    Workspace: 2026-10-18 · saved · fb-checkout-6 · checkout.html.feedback/6-workspace.png
    Review: 2026-10-20 · pin 2 · "reads better"

- [x] #7 Coupon field is confusing
    Round: 2
    Src: 2 · Maya · 04:40 · "What is this box for?"
    Claude: 2026-10-18 · cataloged
    You: 2026-10-18 · reject · out of scope
`;

const opts = (ops: unknown, by: 'Claude' | 'You' = 'Claude') => ({ output: 'prototype/checkout.html', ops, by, date: '2026-10-21' });

describe('feedback files', () => {
  it('parses rounds, items, sources and derived state', () => {
    const doc = parseFeedback(SAMPLE);
    expect(doc.title).toBe('Feedback · checkout.html');
    expect(doc.rounds).toEqual([
      { n: 2, label: 'SME', date: '2026-10-18', source: 'transcripts/sme-2.md' },
      { n: 1, label: 'customers', date: '2026-10-12', source: 'transcripts/cust-1.md' },
    ]);
    const [six, seven] = doc.items;
    expect(six).toMatchObject({ n: 6, checked: false, state: 'open', round: 1, rounds: [1, 2], where: '#filters', related: [{ path: 'pricing.html', n: 3 }] });
    expect(six!.sources[1]).toEqual({ round: 2, speaker: 'Maya', time: '00:14', quote: "I couldn't find the filters" });
    expect(six!.events.at(-2)).toEqual({ key: 'Workspace', date: '2026-10-18', verb: 'saved', detail: 'fb-checkout-6 · checkout.html.feedback/6-workspace.png' });
    expect(six!.before).toEqual(['checkout.html.feedback/6-r1-before.png']);
    expect(seven).toMatchObject({ checked: true, state: 'rejected', rounds: [2] });
  });

  it('round trips the canonical text', () => {
    expect(serializeFeedback(parseFeedback(SAMPLE))).toBe(SAMPLE);
  });

  it('derives state from the last state verb, and from the checkbox without one', () => {
    const state = (lines: string, box = ' ') => parseFeedback(`- [${box}] #1 A\n${lines}`).items[0]!.state;
    expect(state('    Claude: 2026-10-01 · cataloged')).toBe('open');
    expect(state('    You: 2026-10-01 · accept\n    You: 2026-10-02 · note · later')).toBe('accepted');
    expect(state('    You: 2026-10-01 · accept\n    Claude: 2026-10-02 · done')).toBe('done');
    expect(state('    Claude: 2026-10-02 · done\n    You: 2026-10-03 · reopen')).toBe('open');
    expect(state('', 'x')).toBe('done');
  });

  it('creates a file with a round and items, numbered after the highest', () => {
    const first = applyFeedbackOps(undefined, opts([
      { op: 'addRound', label: 'customers', source: 'transcripts/cust-1.md' },
      { op: 'addItem', title: 'Filters are hidden', lines: [{ key: 'Src', text: '1 · Ana · 03:02 · "Where do I filter?"' }, { key: 'Where', text: '#filters' }] },
      { op: 'addItem', title: 'Pay button is low' },
    ]));
    expect(first.added).toEqual({ rounds: [1], items: [1, 2] });
    expect(first.text).toBe(`# Feedback · checkout.html

## Round 1 · customers · 2026-10-21 · transcripts/cust-1.md

- [ ] #1 Filters are hidden
    Round: 1
    Src: 1 · Ana · 03:02 · "Where do I filter?"
    Where: #filters
    Claude: 2026-10-21 · cataloged

- [ ] #2 Pay button is low
    Round: 1
    Claude: 2026-10-21 · cataloged
`);
    const second = applyFeedbackOps(first.text, opts([{ op: 'addRound', label: 'SME' }, { op: 'addItem', title: 'Copy is long' }]));
    expect(second.added).toEqual({ rounds: [2], items: [3] });
    expect(parseFeedback(second.text).rounds.map((r) => r.n)).toEqual([2, 1]);
    expect(parseFeedback(second.text).items.at(-1)).toMatchObject({ n: 3, round: 2 });
  });

  it('only adds lines and flips checkboxes, leaving every other byte as it was', () => {
    const hand = SAMPLE.replace('    You: 2026-10-18 · reject', '  You: 2026-10-18 · reject').replace('# Feedback', 'Intro text\n\n# Feedback');
    const { text } = applyFeedbackOps(hand, opts([
      { op: 'append', item: 6, key: 'Src', text: '2 · Lee · 10:00 · "Filters again"' },
      { op: 'append', item: 7, key: 'Claude', text: 'note · will revisit' },
    ]));
    const added = text.split('\n').filter((l) => !hand.split('\n').includes(l));
    expect(added).toEqual(['    Src: 2 · Lee · 10:00 · "Filters again"', '  Claude: 2026-10-21 · note · will revisit']);
    const removed = hand.split('\n').filter((l) => !text.split('\n').includes(l));
    expect(removed).toEqual([]);
    expect(text.startsWith('Intro text\n')).toBe(true);
  });

  it('moves the checkbox with a state verb', () => {
    const rejected = applyFeedbackOps(SAMPLE, opts([{ op: 'append', item: 6, key: 'You', text: 'reject · not now' }], 'You'));
    expect(parseFeedback(rejected.text).items[0]).toMatchObject({ checked: true, state: 'rejected' });
    const reopened = applyFeedbackOps(rejected.text, opts([{ op: 'append', item: 7, key: 'You', text: 'reopen' }], 'You'));
    expect(parseFeedback(reopened.text).items[1]).toMatchObject({ checked: false, state: 'open' });
    const closed = applyFeedbackOps(SAMPLE, opts([{ op: 'close', item: 6 }]));
    expect(closed.text).toContain('- [x] #6 Hard to find the filters');
  });

  it('refuses bad ops without changing anything', () => {
    const bad = [
      [{ op: 'append', item: 9, key: 'Change', text: 'x' }],
      [{ op: 'append', item: 6, key: 'Round', text: '2' }],
      [{ op: 'append', item: 6, key: 'You', text: 'accept' }],
      [{ op: 'append', item: 6, key: 'Claude', text: '2026-10-01 · done' }],
      [{ op: 'append', item: 6, key: 'Src', text: '9 · Ana · 1:00 · "x"' }],
      [{ op: 'append', item: 6, key: 'Change', text: 'two\nlines' }],
      [{ op: 'addItem', title: 'x', round: 5 }],
      [{ op: 'addRound', label: 'a · b' }],
      [{ op: 'rename', item: 6 }],
      [],
    ];
    for (const ops of bad) expect(() => applyFeedbackOps(SAMPLE, opts(ops))).toThrow();
    expect(() => applyFeedbackOps(undefined, opts([{ op: 'addItem', title: 'No round yet' }]))).toThrow('Add a round first');
    expect(() => applyFeedbackOps(SAMPLE, opts([{ op: 'append', item: 6, key: 'Claude', text: 'done' }], 'You'))).toThrow('Only Claude');
    expect(() => applyFeedbackOps(SAMPLE, opts([{ op: 'append', item: 6, key: 'You', text: 'shrug' }], 'You'))).toThrow('You lines start with');
  });

  it('lists your lines since the last send and builds the message', () => {
    const doc = { ...parseFeedback(SAMPLE), path: 'prototype/checkout.html.feedback.md', output: 'prototype/checkout.html', version: 'v' };
    expect(pendingDecisions(doc).map((p) => [p.item.n, p.said.map((e) => e.verb)])).toEqual([[6, ['accept', 'reopen']], [7, ['reject']]]);
    const sent = applyFeedbackOps(SAMPLE, opts([{ op: 'append', item: 6, key: 'You', text: 'sent' }, { op: 'append', item: 7, key: 'You', text: 'sent' }], 'You'));
    const after = parseFeedback(sent.text);
    expect(pendingDecisions(after)).toEqual([]);
    expect(after.items.map((i) => i.state)).toEqual(['open', 'rejected']);
    const message = decisionsPrompt(doc, pendingDecisions(doc));
    expect(message.split('\n').slice(0, 5)).toEqual([
      '@prototype/checkout.html.feedback.md',
      'Feedback decisions on prototype/checkout.html from Agent Brief, 2 items:',
      '- #6 Hard to find the filters: accept · keep it sticky on scroll; reopen · too long on mobile',
      '  Saved workspace: board fb-checkout-6, picture prototype/checkout.html.feedback/6-workspace.png',
      '- #7 Coupon field is confusing: reject · out of scope',
    ]);
  });

  it('finds items that share words with a point', () => {
    const docs = [{ output: 'checkout.html', items: parseFeedback(SAMPLE).items }];
    expect(relatedCandidates(docs, 'Customers could not find the filter controls').map((h) => h.item.n)).toEqual([6]);
    expect(relatedCandidates(docs, 'Filters hidden', { output: 'checkout.html', n: 6 })).toEqual([]);
  });
});
