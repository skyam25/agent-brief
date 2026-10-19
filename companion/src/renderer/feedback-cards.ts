/** What the Feedback panel's cards show and which ones it lists. */

import type { FeedbackEvent, FeedbackItem, FeedbackLine } from '../protocol';

export type FeedbackFilter = 'open' | 'all';

export const isClosed = (item: FeedbackItem) => item.state === 'done' || item.state === 'rejected';

/** Open items, and closed ones a later round raised again, wait on the user. */
export const needsLook = (item: FeedbackItem) => item.state === 'open' || item.raisedAgain !== undefined;

/** The Open filter keeps everything not closed, and closed items raised again. */
export const inOpenFilter = (item: FeedbackItem) => !isClosed(item) || item.raisedAgain !== undefined;

const RECEIPT = /^(\d{4}-\d{2}-\d{2} · )?sent( · |$)/;
const isReceipt = (l: FeedbackLine) => l.key === 'You' && RECEIPT.test(l.text);

/** The item's lines without its Round line and Send receipts. */
export const historyLines = (item: FeedbackItem) => item.lines.filter((l) => l.key !== 'Round' && !isReceipt(l));

function lastIndex<T>(list: T[], test: (x: T) => boolean): number {
  for (let i = list.length - 1; i >= 0; i--) if (test(list[i]!)) return i;
  return -1;
}

/** Your newest note or decision. */
export const latestSaid = (item: FeedbackItem): FeedbackEvent | undefined => item.events[lastIndex(item.events, (e) => e.key === 'You' && e.verb !== 'sent')];

/**
 * Claude wrote after your last You line, a receipt included, beyond the first `seen` events.
 * An item you never answered is new, not updated.
 */
export function updatedSince(item: FeedbackItem, seen = 0): boolean {
  const you = lastIndex(item.events, (e) => e.key === 'You');
  const claude = lastIndex(item.events, (e) => e.key === 'Claude');
  return you >= 0 && claude > you && claude >= seen;
}

/** A You line's text: the verb, the chosen option, then the note. */
export const decisionText = (verb: string, option: string | undefined, note: string) => [verb, ...(option ? [`option ${option}`] : []), ...(note ? [note] : [])].join(' · ');

/** Events seen per item, by feedback file and number, kept while the app runs. */
const seen = new Map<string, number>();
const seenKey = (path: string, n: number) => `${path}#${n}`;
export const seenCount = (path: string, n: number) => seen.get(seenKey(path, n)) ?? 0;
export const markSeen = (path: string, item: FeedbackItem) => seen.set(seenKey(path, item.n), item.events.length);
