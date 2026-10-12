/** Messages between the review pane and the overlay script inside the page it shows. */

import type { ReviewAnchor, ReviewRect } from '../shared/review';

/** Tags every message both ways, so other postMessage traffic is ignored. */
export const REVIEW_SOURCE = 'agent-brief-review';

/** A pin as the page draws it. `n` is the number on the marker. */
export interface PagePin {
  id: string;
  n: number;
  selector: string;
  fx: number;
  fy: number;
  active?: boolean;
}

/** From the page to the pane. */
export type FromPage =
  | { type: 'ready'; path: string; title: string }
  /** A new pin. `view` is the box to crop, in the frame's viewport pixels. */
  | { type: 'pin'; anchor: ReviewAnchor; view: ReviewRect }
  /** The user clicked a marker. */
  | { type: 'open-pin'; id: string }
  /** Pins whose element the page no longer has. */
  | { type: 'missing'; ids: string[] }
  /** An http or https link the user clicked. */
  | { type: 'link'; href: string }
  /** A pane shortcut pressed while the page had focus. */
  | { type: 'key'; key: 'c' | 'Escape' };

/** From the pane to the page. */
export type ToPage =
  | { type: 'commenting'; on: boolean }
  | { type: 'pins'; pins: PagePin[] }
  /** Scrolls a pin's element into view and flashes it. */
  | { type: 'show'; id: string };

export type Tagged<T> = T & { source: typeof REVIEW_SOURCE };

export const isTagged = (data: unknown): data is Tagged<{ type: string }> =>
  !!data && typeof data === 'object' && (data as { source?: unknown }).source === REVIEW_SOURCE && typeof (data as { type?: unknown }).type === 'string';
