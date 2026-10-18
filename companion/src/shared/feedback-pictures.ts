/** Before and after pictures of a feedback item, one pair per round. */

import type { FeedbackItem } from '../protocol';
import { feedbackAssets } from './feedback';

export type SnapSide = 'before' | 'after';

/** `<n>-r<round>-<side>.png`, in the output's sibling folder. */
export const snapName = (n: number, round: number, side: SnapSide) => `${n}-r${round}-${side}.png`;

/** The `Before:` or `After:` text, relative to the feedback file's folder. */
export const snapLine = (output: string, n: number, round: number, side: SnapSide) => `${feedbackAssets(output.split('/').at(-1)!)}/${snapName(n, round, side)}`;

const ROUND_IN_NAME = /-r(\d+)-(?:before|after)\.[a-z]+$/i;

export interface RoundPictures {
  round: number;
  before?: string;
  after?: string;
}

/**
 * The item's pictures by round, oldest first. A picture's round comes from its
 * name, else the item's first round. A later line for the same round and side wins.
 */
export function picturesByRound(item: Pick<FeedbackItem, 'lines' | 'round' | 'rounds'>): RoundPictures[] {
  const byRound = new Map<number, RoundPictures>();
  for (const line of item.lines) {
    if (line.key !== 'Before' && line.key !== 'After') continue;
    const m = ROUND_IN_NAME.exec(line.text);
    const round = m ? Number(m[1]) : (item.round ?? item.rounds[0] ?? 0);
    const at = byRound.get(round) ?? { round };
    at[line.key === 'Before' ? 'before' : 'after'] = line.text;
    byRound.set(round, at);
  }
  return [...byRound.values()].sort((a, b) => a.round - b.round);
}

/** The round the slider opens on: the latest with both pictures, else the latest with any. */
export function defaultPictureRound(rounds: RoundPictures[]): number | undefined {
  return ([...rounds].reverse().find((r) => r.before && r.after) ?? rounds.at(-1))?.round;
}
