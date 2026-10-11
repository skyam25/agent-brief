/** Draft helpers both processes use. */

import type { Draft } from './ipc';

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

/** The first line with words in it, as the list shows it. */
export function draftTitle(body: string, max = 60): string {
  const line = body.split('\n').find((l) => l.trim())?.trim() ?? '';
  const plain = line.replace(/^#+\s*/, '');
  return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain;
}
