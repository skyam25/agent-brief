/** Pins and done marks on boards. A pinned board heads the sidebar. A done board folds away until it changes. */

export interface BoardMarks {
  /** Boards the sidebar lists under Pinned, in pin order. */
  pinnedBoards?: string[];
  /** When each board was sent or marked done, in ms since the epoch. */
  doneBoards?: Record<string, number>;
}

/** A save this soon after the mark is the Send's own flush, so the board stays done. */
export const DONE_GRACE_MS = 5000;

/** Done until someone edits the board after the mark. */
export function isDone(marks: BoardMarks, name: string, updatedAt: number): boolean {
  const at = marks.doneBoards?.[name];
  return at !== undefined && updatedAt <= at + DONE_GRACE_MS;
}

/** Pins or unpins boards, and marks them done or active. Returns the state patch. */
export function mark(marks: BoardMarks, names: readonly string[], change: { pinned?: boolean; done?: boolean }, now: number): BoardMarks {
  const patch: BoardMarks = {};
  if (change.pinned !== undefined) {
    const kept = (marks.pinnedBoards ?? []).filter((n) => !names.includes(n));
    patch.pinnedBoards = change.pinned ? [...kept, ...names] : kept;
  }
  if (change.done !== undefined) {
    const done = { ...marks.doneBoards };
    for (const n of names) {
      if (change.done) done[n] = now;
      else delete done[n];
    }
    patch.doneBoards = done;
  }
  return patch;
}

/** Follows a board rename. */
export function renameMarks(marks: BoardMarks, from: string, to: string): BoardMarks {
  const done = { ...marks.doneBoards };
  if (from in done) {
    done[to] = done[from];
    delete done[from];
  }
  return { pinnedBoards: (marks.pinnedBoards ?? []).map((n) => (n === from ? to : n)), doneBoards: done };
}

/** Drops the marks of deleted boards. */
export function forgetMarks(marks: BoardMarks, names: readonly string[]): BoardMarks {
  const done = { ...marks.doneBoards };
  for (const n of names) delete done[n];
  return { pinnedBoards: (marks.pinnedBoards ?? []).filter((n) => !names.includes(n)), doneBoards: done };
}
