/** Text output and offline reads for `agent-brief initiative`. */

import path from 'node:path';
import type { Initiative, InitiativeRevision, InitiativeSummary } from '../src/protocol';

/** Overrides the app's data folder, as it does for the app. */
export const DATA_DIR_ENV = 'COMPANION_DATA_DIR';

/** `~/Library/Application Support/Agent Brief`, where the app keeps `initiatives.json`. */
export function defaultDataDir(home: string): string {
  return path.join(home, 'Library', 'Application Support', 'Agent Brief');
}

export function formatSummaries(list: InitiativeSummary[], empty: string): string {
  if (list.length === 0) return empty;
  return list
    .map((s) => `${s.id}  ${s.title}${s.line ? ` · ${s.line}` : ''}${s.score !== undefined ? `  (score ${s.score})` : ''}`)
    .join('\n');
}

const list = (lines: string[]) => (lines.length ? lines.map((l) => `- ${l}`).join('\n') : '(none)');

export function formatInitiative(i: Initiative, history?: InitiativeRevision[]): string {
  const lines = [
    `${i.title}  (id ${i.id}, revision ${i.revision}, by ${i.updatedBy} ${i.updatedAt.slice(0, 10)})`,
    `Brief: ${i.path}${i.missing ? '  (missing)' : ''}`,
  ];
  if (i.sessions?.length) lines.push(`Attached: ${i.sessions.join(', ')}`);
  lines.push('', 'Understanding', i.understanding || '(empty)', '', 'Decisions', list(i.decisions), '', 'Open', list(i.open));
  lines.push('', 'Folders', list(i.folders.map((f) => `${f.path} → ${f.role}${f.note ? ` · ${f.note}` : ''}`)));
  if (history?.length) {
    lines.push('', 'History');
    for (const r of history.slice(0, 10)) {
      lines.push(`- r${r.revision} ${r.updatedAt.slice(0, 16).replace('T', ' ')} ${r.updatedBy}${r.changed ? ` · ${r.changed.join(', ')}` : ''}`);
    }
  }
  return lines.join('\n');
}
