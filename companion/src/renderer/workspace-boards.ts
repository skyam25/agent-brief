/** Workspace boards open in a feedback layer. Main's requests for those boards go to the layer's controller. */

import type { BoardReply, BoardRequest } from '../shared/ipc';
import { BoardCommentsStore } from './board-comments';
import type { BoardController } from './controller';

/** Pins and words on workspace boards. They outlast the layer until a Save keeps them on the item. */
export const workspaceComments = new BoardCommentsStore();

const held = new Set<BoardController>();

/** Routes requests for the controller's board to it until the returned release runs. */
export function holdWorkspace(controller: BoardController): () => void {
  held.add(controller);
  return () => void held.delete(controller);
}

/** The layer's answer to a request for its board. Undefined when no open layer shows that board. */
export function workspaceReply(req: BoardRequest): Promise<BoardReply> | undefined {
  const board = (req.args as { board?: unknown }).board;
  if (req.op === 'show' || typeof board !== 'string') return undefined;
  for (const c of held) if (c.board === board && c.api) return c.reply(req);
  return undefined;
}

export const flushWorkspaces = () => Promise.all([...held].map((c) => c.flush()));
