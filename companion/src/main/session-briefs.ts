/** Which board and note each Claude Code session last worked on, so /sketch and /write reopen them. */

import { CURRENT_BOARD, type SessionHost, type SessionInfo } from '../protocol';
import { folderName } from '../shared/sessions';

export interface SessionBrief {
  /** The session's title, or its folder, as it last read. Kept for sessions that have ended. */
  title?: string;
  /** Where the session ran. */
  cwd?: string;
  /** The terminal it ran in, kept for resuming it after it ends. */
  host?: SessionHost;
  board?: string;
  draftId?: string;
  /** Which of the two it opened last, which a switch to the session reopens. */
  last?: 'board' | 'draft';
  /** The user asked Claude to keep an items file at `<cwd>/.feedback/items/<sessionId>.md`. */
  trackItems?: boolean;
  /**
   * Outputs the user hid, by ref, with the record's `outputTouchedAt` when hidden.
   * A record stays hidden until a later write or declaration moves it past that time.
   */
  dismissedOutputs?: Record<string, number>;
  /** When the session last used it, in ms since the epoch. */
  at: number;
}

export type SessionBriefs = Record<string, SessionBrief>;

export const BRIEF_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_BRIEFS = 100;

/** Drops records older than 30 days, then keeps the newest 100. */
export function prune(briefs: SessionBriefs, now: number): SessionBriefs {
  const fresh = Object.entries(briefs)
    .filter(([, b]) => now - b.at <= BRIEF_TTL_MS)
    .sort(([, a], [, b]) => b.at - a.at)
    .slice(0, MAX_BRIEFS);
  return Object.fromEntries(fresh);
}

/** Records what a session just opened. */
export function remember(
  briefs: SessionBriefs,
  sessionId: string,
  patch: Partial<Omit<SessionBrief, 'at'>>,
  now: number,
): SessionBriefs {
  return prune({ ...briefs, [sessionId]: { ...briefs[sessionId], ...patch, at: now } }, now);
}

/** What a live session tells its brief: its title, folder and terminal. */
export function liveFields(live: SessionInfo): Pick<SessionBrief, 'title' | 'cwd' | 'host'> {
  return { title: live.title || folderName(live.cwd), cwd: live.cwd, ...(live.host ? { host: live.host } : {}) };
}

/** Updates the briefs of live sessions without moving them. Returns `briefs` itself when nothing changed. */
export function refreshLive(briefs: SessionBriefs, live: SessionInfo[]): SessionBriefs {
  let next = briefs;
  for (const s of live) {
    const b = briefs[s.sessionId];
    if (!b) continue;
    const fields = liveFields(s);
    const changed = (Object.keys(fields) as (keyof typeof fields)[]).some((k) => JSON.stringify(b[k]) !== JSON.stringify(fields[k]));
    if (changed) next = { ...next, [s.sessionId]: { ...b, ...fields } };
  }
  return next;
}

/** Follows a board rename, so the session still finds it. */
export function renameBoard(briefs: SessionBriefs, from: string, to: string): SessionBriefs {
  return Object.fromEntries(Object.entries(briefs).map(([id, b]) => [id, b.board === from ? { ...b, board: to } : b]));
}

/** Forgets a deleted board, so no session tries to reopen it. */
export function forgetBoard(briefs: SessionBriefs, board: string): SessionBriefs {
  return Object.fromEntries(
    Object.entries(briefs).map(([id, b]) => {
      if (b.board !== board) return [id, b];
      const { board: _gone, last, ...rest } = b;
      return [id, rest.draftId ? { ...rest, last: 'draft' } : rest];
    }),
  );
}

export interface BoardChoice {
  /** The board to open. */
  board: string;
  /** Whether it has to be created first. */
  isNew: boolean;
}

/**
 * The board /sketch opens for a session: the one it last used if it still exists,
 * else the current board when it is empty and no other session holds it, else a
 * new board named after the session.
 */
export function sketchBoard(opts: {
  sessionId: string;
  briefs: SessionBriefs;
  current: string;
  label: string;
  exists: (name: string) => boolean;
  isEmpty: (name: string) => boolean;
}): BoardChoice {
  const remembered = opts.briefs[opts.sessionId]?.board;
  if (remembered && opts.exists(remembered)) return { board: remembered, isNew: false };
  const heldByOther = Object.entries(opts.briefs).some(([id, b]) => id !== opts.sessionId && b.board === opts.current);
  if (opts.isEmpty(opts.current) && !heldByOther) return { board: opts.current, isNew: false };
  return { board: sessionBoardName(opts.label, opts.exists), isNew: true };
}

/** A free board name from a session's title or folder: `agent-brief`, then `agent-brief 2`. */
export function sessionBoardName(label: string, exists: (name: string) => boolean): string {
  let base = label
    .replace(/[^\w .-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[^\w]+/, '')
    .trim()
    .slice(0, 58)
    .trim();
  if (!base) base = 'session';
  if (base === CURRENT_BOARD) base = `${base} session`;
  let name = base;
  for (let n = 2; exists(name); n++) name = `${base} ${n}`;
  return name;
}
