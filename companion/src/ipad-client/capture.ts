/** Puts the iPad's strokes and on-device speech on one clock and shapes the delivery. */

import type { IpadDelivery, IpadUtterance } from '../shared/ipad';
import type { StrokeEvent } from '../voice/types';

/**
 * Moves strokes and speech so the earliest of either is 0.
 * `strokes` are already rebased to their own earliest event, which sat at epoch ms `strokeOrigin`.
 * `spoken` is in epoch ms. Both clocks are this iPad's.
 */
export function onOneClock(
  strokes: readonly StrokeEvent[],
  strokeOrigin: number | undefined,
  spoken: readonly IpadUtterance[],
): { strokes: StrokeEvent[]; utterances: IpadUtterance[] } {
  const starts = spoken.map((u) => u.t);
  if (strokeOrigin !== undefined) starts.push(strokeOrigin);
  const origin = starts.length ? Math.min(...starts) : 0;
  const shift = strokeOrigin === undefined ? 0 : strokeOrigin - origin;
  return {
    strokes: strokes.map((s) => ({ ...s, t: s.t + shift, tEnd: s.tEnd + shift })),
    utterances: spoken.map((u) => ({ text: u.text, t: u.t - origin, tEnd: Math.max(u.tEnd, u.t) - origin })),
  };
}

export function toBase64(bytes: Uint8Array): string {
  const chunk = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

/**
 * The delivery the native app stores in its outbox. It adds `notes`, which it keeps itself.
 * Throws unless the canvas holds `board`, because a sent hand-off's work is deleted.
 */
export function deliveryOf(
  payload: { boardName: string; png: Uint8Array; scene: unknown; strokes: StrokeEvent[]; bounds: IpadDelivery['bounds'] },
  strokeOrigin: number | undefined,
  spoken: readonly IpadUtterance[],
  board: string,
): IpadDelivery {
  if (payload.boardName !== board) throw new Error('The board on screen is not the one being sent.');
  return {
    pngBase64: toBase64(payload.png),
    scene: payload.scene,
    bounds: payload.bounds,
    ...onOneClock(payload.strokes, strokeOrigin, spoken),
  };
}
