/** Which board and note each Claude Code session last worked on, so /sketch and /write reopen them. */

import { CURRENT_BOARD, type BoardsResponse, type SessionHost, type SessionInfo } from '../protocol';
import { folderName } from '../shared/sessions';
import { DEFAULT_BOARD } from './store';

export interface SessionBrief {
  /** The session's title, or its folder, as it last read. Kept for sessions that have ended. */
  title?: string;
  /** Where the session ran. */
  cwd?: string;
  /** The terminal it ran in, kept for resuming it after it ends. */
  host?: SessionHost;
  /** The board the session opened last. */
  board?: string;
  /** Every board the session has held, newest last. A brief without it holds just `board`. */
  boards?: string[];
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

/** Every board a brief holds, newest last. `board` is always among them. */
export function heldBoards(brief: SessionBrief): string[] {
  const boards = brief.boards ?? [];
  return brief.board && !boards.includes(brief.board) ? [...boards, brief.board] : boards;
}

/** Records what a session just opened. A board it opens joins its list. */
export function remember(
  briefs: SessionBriefs,
  sessionId: string,
  patch: Partial<Omit<SessionBrief, 'at'>>,
  now: number,
): SessionBriefs {
  const prev = briefs[sessionId];
  const next: SessionBrief = { ...prev, ...patch, at: now };
  if (patch.board) {
    const held = prev ? heldBoards(prev) : [];
    next.boards = held.includes(patch.board) ? held : [...held, patch.board];
  }
  return prune({ ...briefs, [sessionId]: next }, now);
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
  return Object.fromEntries(
    Object.entries(briefs).map(([id, b]) => {
      if (!heldBoards(b).includes(from)) return [id, b];
      const boards = heldBoards(b).map((n) => (n === from ? to : n));
      return [id, { ...b, boards, ...(b.board === from ? { board: to } : {}) }];
    }),
  );
}

/**
 * Takes one board out of a brief. When it was the last one opened, the brief
 * falls back to its newest remaining board, else to its note.
 */
function dropBoard(brief: SessionBrief, board: string): SessionBrief {
  const held = heldBoards(brief);
  if (!held.includes(board)) return brief;
  const { boards: _old, ...rest } = brief;
  const boards = held.filter((n) => n !== board);
  const next: SessionBrief = boards.length ? { ...rest, boards } : rest;
  if (brief.board !== board) return next;
  const fallback = boards.at(-1);
  if (fallback) return { ...next, board: fallback };
  const { board: _gone, last: _last, ...bare } = next;
  return bare.draftId ? { ...bare, last: 'draft' } : bare;
}

/** Forgets a deleted board, so no session tries to reopen it. */
export function forgetBoard(briefs: SessionBriefs, board: string): SessionBriefs {
  return Object.fromEntries(Object.entries(briefs).map(([id, b]) => [id, dropBoard(b, board)]));
}

/** Takes a board out of one session's brief, which leaves it unfiled unless another session holds it. */
export function detachBoard(briefs: SessionBriefs, sessionId: string, board: string): SessionBriefs {
  const brief = briefs[sessionId];
  return brief ? { ...briefs, [sessionId]: dropBoard(brief, board) } : briefs;
}

/**
 * The session whose brief holds a board. Ended sessions count until their brief goes.
 * When two briefs hold it, a live session beats an ended one, then the most recently used wins.
 */
export function boardHolder(briefs: SessionBriefs, board: string, isLive: (sessionId: string) => boolean = () => false): string | undefined {
  let holder: { id: string; live: boolean; at: number } | undefined;
  for (const [id, b] of Object.entries(briefs)) {
    if (!heldBoards(b).includes(board)) continue;
    const live = isLive(id);
    const beats = !holder || (live !== holder.live ? live : b.at > holder.at);
    if (beats) holder = { id, live, at: b.at };
  }
  return holder?.id;
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
 * new board named after today's date.
 */
export function sketchBoard(opts: {
  sessionId: string;
  briefs: SessionBriefs;
  current: string;
  now: number;
  exists: (name: string) => boolean;
  isEmpty: (name: string) => boolean;
}): BoardChoice {
  const remembered = opts.briefs[opts.sessionId]?.board;
  if (remembered && opts.exists(remembered)) return { board: remembered, isNew: false };
  const heldByOther = Object.entries(opts.briefs).some(([id, b]) => id !== opts.sessionId && heldBoards(b).includes(opts.current));
  if (opts.isEmpty(opts.current) && !heldByOther) return { board: opts.current, isNew: false };
  return { board: sessionBoardName(opts.now, opts.exists), isNew: true };
}

/**
 * The board Unfiled opens: the one it last used if it still exists and no session
 * holds it, else the most recently updated unfiled board, else a new `scratch`.
 */
export function unfiledBoardChoice(opts: {
  remembered: string | undefined;
  /** Every board, each with the session that holds it. */
  boards: BoardsResponse['boards'];
}): BoardChoice {
  const unfiled = opts.boards.filter((b) => !b.sessionId);
  if (opts.remembered && unfiled.some((b) => b.name === opts.remembered)) return { board: opts.remembered, isNew: false };
  const newest = unfiled.reduce<(typeof unfiled)[number] | undefined>((a, b) => (!a || b.updatedAt > a.updatedAt ? b : a), undefined);
  if (newest) return { board: newest.name, isNew: false };
  return { board: freeName(DEFAULT_BOARD, (n) => opts.boards.some((b) => b.name === n)), isNew: true };
}

/** `base` if no board has it, else `base 2`, `base 3` and on. */
function freeName(base: string, exists: (name: string) => boolean): string {
  let name = base;
  for (let n = 2; exists(name); n++) name = `${base} ${n}`;
  return name;
}

/** A free board name from the date: `Oct 16`, then `Oct 16 2`. */
export function sessionBoardName(now: number, exists: (name: string) => boolean): string {
  let base = new Date(now)
    .toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    .replace(/[^\w .-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[^\w]+/, '')
    .trim()
    .slice(0, 58)
    .trim();
  if (!base) base = 'session';
  if (base === CURRENT_BOARD) base = `${base} session`;
  return freeName(base, exists);
}
