/** Review drafts: comments pinned to elements of a project's HTML file, and the review.md a Send writes. */

import { ATTACHMENT_ID } from './attachments';

export interface ReviewRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Where a comment sits on the page, as the overlay read it when the pin dropped. */
export interface ReviewAnchor {
  /** A CSS selector that matched only this element. */
  selector: string;
  tag: string;
  /** The words the user selected, when the pin came from a selection. */
  quote?: string;
  /** The element's visible text, cut short. */
  text?: string;
  /** The nearest heading above the element. */
  heading?: string;
  /** The pin's spot inside the element, as fractions of its width and height. */
  fx: number;
  fy: number;
  /** The element's box in page pixels. */
  rect: ReviewRect;
  scrollY: number;
  viewport: { width: number; height: number };
}

export interface ReviewComment {
  id: string;
  text: string;
  anchor: ReviewAnchor;
  /** A crop of the element as it looked, kept as the draft attachment with this id. */
  picture?: string;
  createdAt: number;
}

/** What makes a draft a review: the HTML file it looks at and the pins on it. */
export interface DraftReview {
  /** The HTML file under review, relative to the session's project. */
  path: string;
  comments: ReviewComment[];
  /** Edits made in the pane's edit mode, already saved in the file, as one line each. */
  edits?: string[];
}

/** A review as a Send hands it over. `body` is the overall note. */
export interface ReviewPayload extends DraftReview {
  body?: string;
}

export const MAX_COMMENTS = 100;
export const MAX_EDITS = 200;
const COMMENT_ID = /^[\w-]{1,40}$/;
const HTML = /\.html?$/i;

/** True for a path the review pane opens. */
export const isReviewable = (path: string) => HTML.test(path);

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const clip = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.slice(0, max) : undefined);

function cleanRect(raw: unknown): ReviewRect {
  const r = isRecord(raw) ? raw : {};
  return { x: num(r.x), y: num(r.y), width: Math.max(0, num(r.width)), height: Math.max(0, num(r.height)) };
}

function cleanAnchor(raw: unknown): ReviewAnchor | undefined {
  if (!isRecord(raw)) return undefined;
  const selector = clip(raw.selector, 2000);
  if (!selector) return undefined;
  const view = isRecord(raw.viewport) ? raw.viewport : {};
  const quote = clip(raw.quote, 2000);
  const text = clip(raw.text, 500);
  const heading = clip(raw.heading, 300);
  return {
    selector,
    tag: clip(raw.tag, 40)?.toLowerCase() ?? 'element',
    ...(quote ? { quote } : {}),
    ...(text ? { text } : {}),
    ...(heading ? { heading } : {}),
    fx: Math.min(1, Math.max(0, num(raw.fx))),
    fy: Math.min(1, Math.max(0, num(raw.fy))),
    rect: cleanRect(raw.rect),
    scrollY: num(raw.scrollY),
    viewport: { width: num(view.width), height: num(view.height) },
  };
}

/** Checks a review from the renderer and keeps only its known fields. Undefined when it is not one. */
export function cleanReview(raw: unknown): DraftReview | undefined {
  if (!isRecord(raw)) return undefined;
  const path = typeof raw.path === 'string' ? raw.path.trim() : '';
  if (!path || path.length > 1024) return undefined;
  const comments: ReviewComment[] = [];
  for (const c of Array.isArray(raw.comments) ? raw.comments.slice(0, MAX_COMMENTS) : []) {
    if (!isRecord(c) || typeof c.id !== 'string' || !COMMENT_ID.test(c.id)) continue;
    const anchor = cleanAnchor(c.anchor);
    if (!anchor) continue;
    const picture = typeof c.picture === 'string' && ATTACHMENT_ID.test(c.picture) ? c.picture : undefined;
    comments.push({
      id: c.id,
      text: typeof c.text === 'string' ? c.text.slice(0, 20_000) : '',
      anchor,
      ...(picture ? { picture } : {}),
      createdAt: num(c.createdAt),
    });
  }
  const edits = Array.isArray(raw.edits)
    ? raw.edits.filter((e): e is string => typeof e === 'string' && !!e.trim()).slice(-MAX_EDITS).map((e) => e.slice(0, 300))
    : [];
  return { path, comments, ...(edits.length ? { edits } : {}) };
}

/** The attachment ids a review's comments use, in order. */
export const reviewPictures = (review: DraftReview | undefined): string[] =>
  (review?.comments ?? []).flatMap((c) => (c.picture ? [c.picture] : []));

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** A pin's name in lists: its tag and the words it shows, like `h2 “Pricing plans”`. */
export function anchorLabel(a: ReviewAnchor, max = 60): string {
  const words = oneLine(a.quote ?? a.text ?? '');
  return words ? `${a.tag} “${cut(words, max)}”` : a.tag;
}

/** `3 comments`, `1 comment`. */
export const commentCount = (n: number) => `${n} comment${n === 1 ? '' : 's'}`;

/** `3 edits`, `1 edit`. */
export const editCount = (n: number) => `${n} edit${n === 1 ? '' : 's'}`;

/** True when a review holds something to send: a comment, an edit or an overall note. */
export const hasReviewContent = (review: DraftReview, body: string) => review.comments.length > 0 || (review.edits?.length ?? 0) > 0 || !!body.trim();

/** A file name from a project path. */
export const baseName = (path: string) => path.split('/').filter(Boolean).at(-1) ?? path;

/**
 * The review.md a Send writes. `picturePath` names a comment picture's file
 * as Claude should open it, or undefined when the picture did not make it.
 */
export function reviewMarkdown(review: ReviewPayload, picturePath: (id: string) => string | undefined): string {
  const lines = [
    `# Review of ${review.path}`,
    '',
    'Comments pinned to elements of the page in Agent Brief. Each names its element with a CSS selector, the text it showed, and the nearest heading above it.',
  ];
  const overall = review.body?.trim();
  if (overall) lines.push('', '## Overall', '', overall);
  review.comments.forEach((c, i) => {
    const a = c.anchor;
    lines.push('', `## ${i + 1}. ${anchorLabel(a)}`, '', c.text.trim() || '(No words. The pin marks this element.)', '');
    lines.push(`- Element: \`${a.selector.replace(/`/g, '\\`')}\``);
    if (a.heading) lines.push(`- Under heading: “${cut(oneLine(a.heading), 120)}”`);
    if (a.quote) lines.push(`- Selected text: “${cut(oneLine(a.quote), 400)}”`);
    else if (a.text) lines.push(`- Element text: “${cut(oneLine(a.text), 200)}”`);
    const r = a.rect;
    lines.push(
      `- Box: ${Math.round(r.width)}×${Math.round(r.height)} at ${Math.round(r.x)},${Math.round(r.y)} on the page, seen in a ${Math.round(a.viewport.width)}×${Math.round(a.viewport.height)} view`,
    );
    const picture = c.picture && picturePath(c.picture);
    if (picture) lines.push(`- Picture: ${picture}`);
  });
  const edits = review.edits ?? [];
  if (edits.length) {
    lines.push('', '## Edited in the pane', '', `These edits are already saved in ${review.path}, in this order.`, '');
    for (const e of edits) lines.push(`- ${oneLine(e)}`);
  }
  return `${lines.join('\n')}\n`;
}

/** The prompt line after the `@review.md` line. */
export function reviewAsk(review: ReviewPayload): string {
  const n = review.comments.length;
  const e = review.edits?.length ?? 0;
  if (e && !n && !review.body?.trim()) {
    return `Review of ${review.path} from Agent Brief: ${editCount(e)} made in the pane, already saved in the file. Check them and tidy the markup where it needs it, then say what changed.`;
  }
  const what = n ? `${commentCount(n)} pinned to the page` : 'an overall note';
  const saved = e ? `, plus ${editCount(e)} already saved in the file` : '';
  return `Review of ${review.path} from Agent Brief, ${what}${saved}. Make the changes in ${review.path}, then say what changed.`;
}
