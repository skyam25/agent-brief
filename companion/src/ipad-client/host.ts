/** The board's host inside the iPad app: scenes live with the native app, and everything else does not apply here. */

import type { BoardHost, Theme } from '../shared/ipc';

declare global {
  interface Window {
    webkit?: { messageHandlers?: { agentBrief?: { postMessage(message: unknown): void } } };
  }
}

export type NativeMessage = { type: 'ready' } | { type: 'saveBoard'; board: string; json: string } | { type: 'log'; level: 'error'; text: string };

export function toNative(message: NativeMessage): void {
  window.webkit?.messageHandlers?.agentBrief?.postMessage(message);
}

export interface OpenBoard {
  boardName: string;
  scene: string | null;
  notes: string;
}

export class IpadHost implements BoardHost {
  private readonly boards = new Map<string, { scene: string | null; notes: string }>();
  private readonly themeListeners = new Set<(theme: Theme) => void>();

  /** Holds what `open` asks the controller to load next. */
  offer(board: OpenBoard): void {
    this.boards.set(board.boardName, { scene: board.scene, notes: board.notes });
  }

  setTheme(theme: Theme): void {
    for (const fn of this.themeListeners) fn(theme);
  }

  async loadBoard(name: string) {
    return this.boards.get(name) ?? { scene: null, notes: '' };
  }

  async saveBoard(name: string, json: string) {
    const held = this.boards.get(name);
    this.boards.set(name, { scene: json, notes: held?.notes ?? '' });
    toNative({ type: 'saveBoard', board: name, json });
  }

  async saveNotes(name: string, text: string) {
    const held = this.boards.get(name);
    this.boards.set(name, { scene: held?.scene ?? null, notes: text });
  }

  onTheme(fn: (theme: Theme) => void) {
    this.themeListeners.add(fn);
    return () => {
      this.themeListeners.delete(fn);
    };
  }

  async listBoards() {
    return [];
  }

  async createBoard(name: string) {
    return name;
  }

  async renameBoard(_from: string, to: string) {
    return to;
  }

  async deleteBoard() {}
  async setCurrent() {}
  async detachBoard() {}
  async cleanupPlan() {
    return [];
  }
  async cleanUp() {
    return { moved: 0, failed: 0 } as never;
  }
  async moveBoards() {}
  async markBoards() {}
  async send() {
    return { ok: false, message: 'The iPad app sends through its outbox.' };
  }
}
