/** The board list the sidebar and the board picker share. */

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import type { BoardEntry, BoardHost, SessionBriefEntry } from '../shared/ipc';
import type { BoardController } from './controller';

export interface BoardList {
  boards: BoardEntry[];
  /** Fetches the list again, as after a delete that leaves the open board in place. */
  refresh: () => void;
}

/** Fetches the boards on mount, and again when the open board, its layout or the briefs change. */
export function useBoards(host: Pick<BoardHost, 'listBoards'>, controller: BoardController, briefs: SessionBriefEntry[]): BoardList {
  const board = useSyncExternalStore(
    (fn) => controller.subscribe(fn),
    () => controller.board,
  );
  const layout = useSyncExternalStore(
    (fn) => controller.subscribe(fn),
    () => controller.layout,
  );
  const [boards, setBoards] = useState<BoardEntry[]>([]);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    let live = true;
    void host.listBoards().then((list) => live && setBoards(list));
    return () => {
      live = false;
    };
  }, [host, board, layout, briefs, tick]);

  return { boards, refresh };
}
