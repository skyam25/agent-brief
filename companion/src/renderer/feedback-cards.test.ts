import { describe, expect, it } from 'vitest';
import type { FeedbackItem } from '../protocol';
import { parseFeedback } from '../shared/feedback';
import { decisionText, historyLines, inOpenFilter, latestSaid, needsLook, updatedSince } from './feedback-cards';

const one = (state: string, ...lines: string[]): FeedbackItem =>
  parseFeedback(`# Feedback · a.html\n\n## Round 1 · SME · 2026-10-12\n\n- [${state === 'x' ? 'x' : ' '}] #1 Point\n    Round: 1\n${lines.map((l) => `    ${l}\n`).join('')}`).items[0]!;

describe('feedback cards', () => {
  it('counts open and raised-again items as needing a look, and shows accepted ones under Open', () => {
    const open = one(' ', 'Claude: 2026-10-12 · cataloged');
    const accepted = one(' ', 'You: 2026-10-13 · accept');
    const done = one('x', 'Claude: 2026-10-14 · done');
    const raised = { ...done, raisedAgain: 3 };
    expect([open, accepted, done, raised].map(needsLook)).toEqual([true, false, false, true]);
    expect([open, accepted, done, raised].map(inOpenFilter)).toEqual([true, true, false, true]);
  });

  it('leaves Send receipts out of the history', () => {
    const item = one(' ', 'Claude: 2026-10-12 · cataloged', 'You: 2026-10-13 · accept', 'You: 2026-10-13 · sent · through 2', 'You: 2026-10-13 · sent', 'Claude: 2026-10-14 · note · on it');
    expect(historyLines(item).map((l) => l.text)).toEqual(['2026-10-12 · cataloged', '2026-10-13 · accept', '2026-10-14 · note · on it']);
  });

  it('gives your latest note or decision, never a receipt', () => {
    const item = one(' ', 'You: 2026-10-13 · accept · keep it', 'You: 2026-10-13 · note · and on mobile', 'You: 2026-10-13 · sent · through 3');
    expect(latestSaid(item)).toMatchObject({ verb: 'note', detail: 'and on mobile' });
    expect(latestSaid(one(' ', 'Claude: 2026-10-12 · cataloged'))).toBeUndefined();
  });

  it('marks an item Updated when Claude wrote after your last line, receipts included, until it is seen', () => {
    expect(updatedSince(one(' ', 'Claude: 2026-10-12 · cataloged'))).toBe(false);
    expect(updatedSince(one(' ', 'Claude: 2026-10-12 · cataloged', 'You: 2026-10-13 · accept'))).toBe(false);
    const replied = one(' ', 'Claude: 2026-10-12 · cataloged', 'You: 2026-10-13 · accept', 'You: 2026-10-13 · sent · through 2', 'Claude: 2026-10-14 · done');
    expect(updatedSince(replied)).toBe(true);
    // Seen through all four events, then Claude writes again.
    expect(updatedSince(replied, 4)).toBe(false);
    replied.events.push({ key: 'Claude', date: '2026-10-15', verb: 'note', detail: 'one more' });
    expect(updatedSince(replied, 4)).toBe(true);
  });

  it('writes a decision with its option and note', () => {
    expect(decisionText('accept', 'B', 'keep it short')).toBe('accept · option B · keep it short');
    expect(decisionText('accept', undefined, '')).toBe('accept');
    expect(decisionText('reject', undefined, 'not now')).toBe('reject · not now');
  });
});
