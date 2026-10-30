/** Reads a session's outputs file and orders its records for the panel. */

import type { OutputRecord } from '../protocol';

export { cleanOutput, parseOutputsFile } from './output-file';

/** When the record last moved: its declaration or its latest write, whichever is later. */
export function outputTouchedAt(r: OutputRecord): number {
  return Math.max(r.declaredAt ?? 0, r.lastWriteAt ?? 0);
}

/** Declared records first, then detected, each newest on top. */
export function sortOutputs(records: readonly OutputRecord[]): OutputRecord[] {
  const rank = (r: OutputRecord) => (r.tier === 'declared' ? 0 : 1);
  return [...records].sort((a, b) => rank(a) - rank(b) || outputTouchedAt(b) - outputTouchedAt(a) || a.ref.localeCompare(b.ref));
}

/** The row's label: the title, else the file name, else the URL. */
export function outputLabel(r: OutputRecord): string {
  if (r.title) return r.title;
  if (r.url) return r.url;
  return r.ref.split('/').filter(Boolean).at(-1) ?? r.ref;
}

export const isUrlRef = (ref: string): boolean => /^https?:\/\//i.test(ref);

/** Hosts a dev server answers on this Mac. */
const LOCAL_HOST = /^(localhost|127(\.\d{1,3}){3}|0\.0\.0\.0|[\w-]+(\.[\w-]+)*\.(localhost|local))$/i;

/** True for an http or https link to this Mac, as a dev server serves it. The review pane opens these. */
export function isLocalUrl(ref: string): boolean {
  if (!isUrlRef(ref)) return false;
  try {
    return LOCAL_HOST.test(new URL(ref).hostname);
  } catch {
    return false;
  }
}

/** True for a path Write mode opens as a note. */
export const isMarkdownRef = (ref: string): boolean => /\.(md|markdown|mdx)$/i.test(ref);

/**
 * What Review mode opens on: the newest review with comments or a note, else the
 * newest Ready HTML output. Nothing while an item waits on you, so its question stays in view.
 */
export function reviewStart(opts: {
  reviews: readonly { id: string; updatedAt: number; hasContent: boolean }[];
  outputs: readonly OutputRecord[];
  itemWaits: boolean;
}): { draftId: string } | { ref: string } | undefined {
  if (opts.itemWaits) return undefined;
  const review = opts.reviews.filter((r) => r.hasContent).sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (review) return { draftId: review.id };
  const page = opts.outputs
    .filter((r) => r.tier === 'declared' && r.kind === 'html' && r.status === 'ready')
    .sort((a, b) => outputTouchedAt(b) - outputTouchedAt(a))[0];
  return page ? { ref: page.ref } : undefined;
}
