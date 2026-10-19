/** Before and after pictures of a feedback item, one pair per round. */

import type { FeedbackItem } from '../protocol';
import { feedbackAssets } from './feedback';

export type SnapSide = 'before' | 'after';

/** `<n>-r<round>-<side>.png`, in the output's sibling folder. Retakes add `-<rev>`, since pictures never change. */
export const snapName = (n: number, round: number, side: SnapSide, rev = 1) => `${n}-r${round}-${side}${rev > 1 ? `-${rev}` : ''}.png`;

/** The `Before:` or `After:` path, relative to the feedback file's folder. */
export const snapLine = (output: string, n: number, round: number, side: SnapSide, rev = 1) => `${feedbackAssets(output.split('/').at(-1)!)}/${snapName(n, round, side, rev)}`;

/** The picture a `Before:` or `After:` line names, without its ` · ` detail. */
export const picturePath = (text: string) => text.split(' · ')[0]!.trim();

const ROUND_IN_NAME = /-r(\d+)-(?:before|after)(?:-\d+)?\.[a-z]+$/i;

export interface RoundPictures {
  round: number;
  before?: string;
  after?: string;
}

/**
 * The item's pictures by round, oldest first. A picture's round comes from its
 * name, else the item's first round. The round's first Before is its baseline,
 * and its latest After wins.
 */
export function picturesByRound(item: Pick<FeedbackItem, 'lines' | 'round' | 'rounds'>): RoundPictures[] {
  const byRound = new Map<number, RoundPictures>();
  for (const line of item.lines) {
    if (line.key !== 'Before' && line.key !== 'After') continue;
    const path = picturePath(line.text);
    const m = ROUND_IN_NAME.exec(path);
    const round = m ? Number(m[1]) : (item.round ?? item.rounds[0] ?? 0);
    const at = byRound.get(round) ?? { round };
    if (line.key === 'After') at.after = path;
    else at.before ??= path;
    byRound.set(round, at);
  }
  return [...byRound.values()].sort((a, b) => a.round - b.round);
}

/** The round the slider opens on: the latest with both pictures, else the latest with any. */
export function defaultPictureRound(rounds: RoundPictures[]): number | undefined {
  return ([...rounds].reverse().find((r) => r.before && r.after) ?? rounds.at(-1))?.round;
}
