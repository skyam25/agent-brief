/** Messages between the review pane and the overlay script inside the page it shows. */

import type { ReviewAnchor, ReviewRect } from '../shared/review';
import type { EditResult, InsertKind, ReviewEdit, SelectedElement, StyleSet } from '../shared/review-edit';

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
  | { type: 'behavior-missing' }
  /** `version` is the file's as served. `editable` is true when the page has elements edit mode can change. */
  | { type: 'ready'; path: string; title: string; version?: string; editable?: boolean }
  /** A new pin. `view` is the box to crop, in the frame's viewport pixels. `matches` lists the `where` selectors its element sits in. */
  | { type: 'pin'; anchor: ReviewAnchor; view: ReviewRect; matches?: string[] }
  /** The user clicked a marker. */
  | { type: 'open-pin'; id: string }
  /** Pins whose element the page no longer has. */
  | { type: 'missing'; ids: string[] }
  /** An http or https link the user clicked. */
  | { type: 'link'; href: string }
  /** A pane shortcut pressed while the page had focus. */
  | { type: 'key'; key: 'c' | 'e' | 'Escape' | 'undo' | 'redo' }
  /** One edit to save. The page waits for `edited` before it sends the next. */
  | { type: 'edit'; version: string; edit: ReviewEdit }
  /** What edit mode has selected, or null. */
  | { type: 'selected'; element: SelectedElement | null }
  /** The page's elements no longer match the file, so the pane should reload it. */
  | { type: 'reload' }
  /** The answer to `measure`: the element's visible box, or none when the page lacks it. */
  | { type: 'measured'; id: string; view?: ReviewRect }
  /** The user clicked an element. `matches` lists the `where` selectors it sits in. */
  | { type: 'pointed'; matches: string[] };

/** From the pane to the page. */
export type ToPage =
  | { type: 'show-behavior'; selector: string }
  | { type: 'commenting'; on: boolean }
  | { type: 'pins'; pins: PagePin[] }
  /** Scrolls a pin's element into view and flashes it. */
  | { type: 'show'; id: string }
  | { type: 'editing'; on: boolean }
  /** Main's answer to the page's last `edit`. */
  | { type: 'edited'; result: EditResult }
  /** Inspector changes to the selected element. */
  | { type: 'style'; set: StyleSet }
  | { type: 'text'; text: string }
  | { type: 'act'; act: 'parent' | 'duplicate' | 'remove' | 'deselect' }
  | { type: 'insert'; what: InsertKind }
  /** Scrolls the element into view and answers `measured` once it painted. */
  | { type: 'measure'; id: string; selector: string }
  /** Selectors of feedback items, which clicks and pins report back as `matches`. */
  | { type: 'where'; selectors: string[] };

export type Tagged<T> = T & { source: typeof REVIEW_SOURCE };

export const isTagged = (data: unknown): data is Tagged<{ type: string }> =>
  !!data && typeof data === 'object' && (data as { source?: unknown }).source === REVIEW_SOURCE && typeof (data as { type?: unknown }).type === 'string';
