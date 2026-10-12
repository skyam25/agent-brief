/** Draft helpers both processes use. */

import type { Draft, DraftImage } from './ipc';
import { reviewPictures } from './review';

/** A sortable id like `mgk3x2a1-9f2c`. */
export function newDraftId(now = Date.now()): string {
  return `${now.toString(36)}-${Math.random().toString(16).slice(2, 6).padEnd(4, '0')}`;
}

/** Ready drafts by rank, then notes with the newest edit first. */
export function sortDrafts(drafts: Draft[]): Draft[] {
  const ready = drafts.filter((d) => d.status === 'ready').sort((a, b) => a.rank - b.rank || a.createdAt - b.createdAt);
  const notes = drafts.filter((d) => d.status !== 'ready').sort((a, b) => b.updatedAt - a.updatedAt);
  return [...ready, ...notes];
}

/** A picture reference: `![alt](att:<id>)`, with an optional title. Group 1 is the alt text, group 2 the id. */
const IMAGE_REF = /!\[((?:\\.|[^\]\\])*)\]\(att:([a-z0-9]{6,24})(?:\s+"[^"]*")?\)/g;

/** Every picture reference in `text`, in order. */
export function imageRefs(text: string): { match: string; alt: string; id: string; index: number }[] {
  return [...text.matchAll(IMAGE_REF)].map((m) => ({ match: m[0], alt: m[1].replace(/\\(.)/g, '$1'), id: m[2], index: m.index }));
}

/** The attachment ids a body references, in order, each once. */
export function referencedImages(body: string): string[] {
  return [...new Set(imageRefs(body).map((r) => r.id))];
}

/** The attachments a draft keeps: the ones its body references, then its review comments' pictures. */
export const keptImages = (d: Pick<Draft, 'body' | 'review'>): string[] => [...new Set([...referencedImages(d.body), ...reviewPictures(d.review)])];

/** The attachments a draft uses, as a Send hands them over. */
export function draftImages(d: Draft): DraftImage[] {
  const all = d.attachments ?? {};
  return keptImages(d)
    .filter((id) => all[id])
    .map((id) => ({ id, data: all[id] }));
}

/** A table rule or a divider, such as `|---|:--:|` or `---`. */
const RULE = /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/;
const FENCE = /^(```|~~~)/;
/** List, task and quote markers that open a line. */
const MARKERS = /^(?:[-*+]\s+\[[ xX]\](?:\s+|$)|[-*+](?:\s+|$)|\d+[.)](?:\s+|$)|>\s*)+/;

/** A Markdown line as plain words. Empty for a line with no words, such as a lone picture or a table rule. */
function plainLine(line: string): string {
  let s = line.replace(IMAGE_REF, '').trim();
  if (!s || RULE.test(s) || FENCE.test(s)) return '';
  s = s.replace(/^#+\s*/, '').replace(MARKERS, '');
  if (s.startsWith('|')) s = s.split('|').map((c) => c.trim()).filter(Boolean).join(' · ');
  s = s
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*|~~|`/g, '')
    .replace(/(^|\W)[*_]+(?=\S)/g, '$1')
    .replace(/(\S)[*_]+(?=\W|$)/g, '$1')
    .replace(/\\([\\`*_{}[\]()#+\-.!|~>])/g, '$1');
  return s.trim();
}

/** The first line with words in it, as the list shows it. */
export function draftTitle(body: string, max = 60): string {
  let plain = '';
  for (const line of body.split('\n')) if ((plain = plainLine(line))) break;
  return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain;
}

/** The second line with words in it, as plain text. The list shows it under the title. */
export function draftPreview(body: string): string | undefined {
  let found = 0;
  for (const line of body.split('\n')) {
    const plain = plainLine(line);
    if (plain && ++found === 2) return plain;
  }
  return undefined;
}
