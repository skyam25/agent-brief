/** Keeps the sync hub in step with the board files and the Mac panel. */

import { isSyncElement, MAC_CLIENT, type SyncElement, type SyncHub } from '../web/sync-hub';
import { emptyScene, type BoardStore } from './store';

const PERSIST_DELAY_MS = 300;

export interface HubLinkOptions {
  hub: SyncHub;
  store: BoardStore;
  /** The board the Mac panel shows. Its changes from elsewhere go to the renderer. */
  currentBoard: () => string;
  toRenderer: (board: string, elements: SyncElement[]) => void;
}

function elementsOf(json: string | null): SyncElement[] {
  if (!json) return [];
  try {
    const scene = JSON.parse(json) as { elements?: unknown[] };
    return (scene.elements ?? []).filter(isSyncElement);
  } catch {
    return [];
  }
}

export class HubLink {
  private timers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly opts: HubLinkOptions) {
    for (const b of opts.store.list()) this.seed(b.name);
    opts.store.onCreate((name) => this.seed(name));
    opts.hub.onChange((change) => {
      if (change.from === MAC_CLIENT) return;
      if (change.board === opts.currentBoard()) opts.toRenderer(change.board, change.elements);
      else this.schedulePersist(change.board);
    });
  }

  /** Loads a board file into the hub. */
  seed(board: string): void {
    this.opts.hub.local(board, elementsOf(this.opts.store.load(board).scene));
  }

  /** A scene the Mac saved, whole. */
  saved(board: string, json: string): void {
    this.opts.hub.local(board, elementsOf(json));
  }

  /** Elements the Mac panel just changed. */
  pushed(board: string, elements: unknown[]): void {
    this.opts.hub.local(board, elements.filter(isSyncElement));
  }

  private schedulePersist(board: string): void {
    clearTimeout(this.timers.get(board));
    this.timers.set(board, setTimeout(() => this.persist(board), PERSIST_DELAY_MS));
  }

  /** Writes the hub's copy of a board the Mac does not show. */
  persist(board: string): void {
    clearTimeout(this.timers.get(board));
    this.timers.delete(board);
    const { scene } = this.opts.store.load(board);
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(scene ?? emptyScene());
    } catch {
      data = JSON.parse(emptyScene());
    }
    data.elements = this.opts.hub.snapshot(board);
    this.opts.store.saveScene(board, JSON.stringify(data, null, 2));
  }

  /** Writes every pending board now, as on quit. */
  flush(): void {
    for (const board of [...this.timers.keys()]) this.persist(board);
  }
}
