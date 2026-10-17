/** Which boards and notes belong to a container: a session, or Unfiled when `sessionId` is undefined. */

import type { BoardEntry, Draft } from '../shared/ipc';
import { onTab } from './drafts';

/** Boards a session's brief holds, or the boards no session holds. */
export function boardsOf(boards: readonly BoardEntry[], sessionId: string | undefined): BoardEntry[] {
  return boards.filter((b) => (sessionId ? b.sessionId === sessionId : !b.sessionId));
}

/** What the sidebar shows under a container: its boards, and how many notes with text in them it holds. Reviews stay in Review. */
export function childrenOf(
  boards: readonly BoardEntry[],
  drafts: readonly Draft[],
  sessionId: string | undefined,
  tabs: readonly string[],
): { boards: BoardEntry[]; noteCount: number } {
  return {
    boards: boardsOf(boards, sessionId),
    noteCount: drafts.filter((d) => !d.review && d.body.trim() && onTab(d, sessionId, tabs)).length,
  };
}

/**
 * The board menu's rows. `own` holds the container's boards, with the current
 * board first when the list lacks it. `attach` holds the unfiled boards a live
 * session can take. Boards another session holds appear in neither.
 */
export function pickerRows(
  boards: readonly BoardEntry[],
  current: string,
  sessionId: string | undefined,
  canAttach: boolean,
): { own: string[]; attach: string[] } {
  const own = boardsOf(boards, sessionId).map((b) => b.name);
  if (!own.includes(current)) own.unshift(current);
  const attach = canAttach && sessionId ? boardsOf(boards, undefined).map((b) => b.name).filter((n) => n !== current) : [];
  return { own, attach };
}

/** The session's newest board other than `leaving`, to show after `leaving` moves out. Undefined when it holds no other board. */
export function fallbackBoard(boards: readonly BoardEntry[], sessionId: string, leaving: string): string | undefined {
  return boardsOf(boards, sessionId)
    .filter((b) => b.name !== leaving)
    .reduce<BoardEntry | undefined>((newest, b) => (!newest || b.updatedAt > newest.updatedAt ? b : newest), undefined)?.name;
}
