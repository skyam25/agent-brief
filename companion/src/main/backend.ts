/** The app's side of the socket API. Board work runs in the renderer, which owns the scene. */

import { randomBytes } from 'node:crypto';
import { CURRENT_BOARD, type OpenRequest } from '../protocol';
import type { BoardBackend } from '../server/contract';
import { notFound } from '../board/errors';
import type { RendererBridge } from './bridge';
import type { Panel } from './panel';
import type { BoardStore, StateFile } from './store';

export const DEFAULT_MAX_EDGE = 1400;

export interface BackendDeps {
  store: BoardStore;
  state: StateFile;
  panel: Panel;
  bridge: RendererBridge;
  setPrompt: (prompt: string | undefined) => void;
}

export function newBatchId(): string {
  return `b_${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
}

export function createBoardBackend(deps: BackendDeps): BoardBackend {
  const { store, state, panel, bridge } = deps;

  const nameOf = (board: string | undefined): string =>
    !board || board === CURRENT_BOARD ? state.state.currentBoard : board;

  const existing = (board: string): string => {
    const name = nameOf(board);
    if (!store.exists(name)) throw notFound(`no board named ${JSON.stringify(name)}`);
    return name;
  };

  return {
    health: () => ({ panelVisible: panel.isVisible(), currentBoard: state.state.currentBoard }),

    async open(req: OpenRequest) {
      const board = store.create(nameOf(req.board));
      if (req.prompt !== undefined) deps.setPrompt(req.prompt);
      await bridge.request('show', { board });
      if (req.layout) await bridge.request('layout', { board, layout: req.layout });
      panel.show();
      return { board, ...(req.sessionId ? { targetSessionId: req.sessionId } : {}) };
    },

    async listBoards() {
      return { boards: store.list(), current: state.state.currentBoard };
    },

    read: (board, region) => bridge.request('read', { board: existing(board), region }),

    async png(board, opts) {
      const bytes = await bridge.request('png', {
        board: existing(board),
        region: opts.region,
        maxEdge: opts.maxEdge ?? DEFAULT_MAX_EDGE,
      });
      return Buffer.from(bytes);
    },

    draw: (board, req) =>
      bridge.request('draw', { board: store.create(nameOf(board)), req, batchId: newBatchId() }),

    update: (board, req) => bridge.request('update', { board: existing(board), req, batchId: newBatchId() }),

    remove: (board, req) => bridge.request('remove', { board: existing(board), req, batchId: newBatchId() }),
  };
}
