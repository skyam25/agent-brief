/**
 * Holds each board's latest elements and relays changes between clients. The
 * merge rule matches Excalidraw's `reconcileElements`. Types are structural,
 * so nothing here imports Excalidraw.
 */

export interface SyncElement {
  id: string;
  version: number;
  versionNonce: number;
  isDeleted?: boolean;
  [key: string]: unknown;
}

export type HubMessage =
  | { type: 'snapshot'; board: string; elements: SyncElement[] }
  | { type: 'update'; board: string; elements: SyncElement[] };

export interface HubClient {
  id: string;
  send(message: HubMessage): void;
}

export interface HubChange {
  board: string;
  from: string;
  /** Only the elements that changed. */
  elements: SyncElement[];
}

/** Client id the Mac renderer and Claude's draws use. */
export const MAC_CLIENT = 'mac';

/** Whether `remote` replaces `local`. A higher version wins, and a tie goes to the lower nonce. */
export function remoteWins(local: SyncElement, remote: SyncElement): boolean {
  if (remote.version !== local.version) return remote.version > local.version;
  return remote.versionNonce < local.versionNonce;
}

export function isSyncElement(value: unknown): value is SyncElement {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.id === 'string' &&
    typeof e.version === 'number' &&
    Number.isFinite(e.version) &&
    typeof e.versionNonce === 'number' &&
    Number.isFinite(e.versionNonce)
  );
}

interface Board {
  elements: Map<string, SyncElement>;
  clients: Map<string, HubClient>;
  /** JSON length of each element, and their sum. */
  sizes: Map<string, number>;
  bytes: number;
}

const sizeOf = (e: SyncElement) => JSON.stringify(e).length;

export class SyncHub {
  private boardMap = new Map<string, Board>();
  private listeners = new Set<{ board?: string; fn: (c: HubChange) => void }>();

  private board(name: string): Board {
    let b = this.boardMap.get(name);
    if (!b) {
      b = { elements: new Map(), clients: new Map(), sizes: new Map(), bytes: 0 };
      this.boardMap.set(name, b);
    }
    return b;
  }

  /** Adds a client and sends it the board's snapshot. Returns a function that removes it. */
  join(board: string, client: HubClient): () => void {
    const b = this.board(board);
    b.clients.set(client.id, client);
    client.send({ type: 'snapshot', board, elements: [...b.elements.values()] });
    return () => {
      if (b.clients.get(client.id) === client) b.clients.delete(client.id);
    };
  }

  /** Every element on the board, deleted ones included so late joiners learn of deletions. */
  snapshot(board: string): SyncElement[] {
    return [...(this.boardMap.get(board)?.elements.values() ?? [])];
  }

  has(board: string): boolean {
    return this.boardMap.has(board);
  }

  boards(): { name: string; elementCount: number }[] {
    return [...this.boardMap].map(([name, b]) => ({
      name,
      elementCount: [...b.elements.values()].filter((e) => !e.isDeleted).length,
    }));
  }

  /** The board's elements as JSON, deleted ones included, in characters. */
  bytes(board: string): number {
    return this.boardMap.get(board)?.bytes ?? 0;
  }

  /** Whether merging `elements` keeps the board at or under `maxBytes`. */
  fits(board: string, elements: readonly SyncElement[], maxBytes: number): boolean {
    const b = this.boardMap.get(board);
    let bytes = b?.bytes ?? 0;
    const seen = new Map<string, SyncElement>();
    for (const incoming of elements) {
      const current = seen.get(incoming.id) ?? b?.elements.get(incoming.id);
      if (current && !remoteWins(current, incoming)) continue;
      bytes += sizeOf(incoming) - (current ? sizeOf(current) : 0);
      seen.set(incoming.id, incoming);
    }
    return bytes <= maxBytes;
  }

  /**
   * Merges elements from one client and sends the changed ones to the others.
   * The sender gets back any element the hub kept because its own copy won.
   * Returns the changed elements.
   */
  apply(board: string, fromClient: string, elements: readonly SyncElement[]): SyncElement[] {
    const b = this.board(board);
    const changed: SyncElement[] = [];
    const kept: SyncElement[] = [];
    for (const incoming of elements) {
      const current = b.elements.get(incoming.id);
      if (!current || remoteWins(current, incoming)) {
        b.elements.set(incoming.id, incoming);
        const size = sizeOf(incoming);
        b.bytes += size - (b.sizes.get(incoming.id) ?? 0);
        b.sizes.set(incoming.id, size);
        changed.push(incoming);
      } else if (current.version !== incoming.version || current.versionNonce !== incoming.versionNonce) {
        kept.push(current);
      }
    }

    if (kept.length > 0) b.clients.get(fromClient)?.send({ type: 'update', board, elements: kept });
    if (changed.length === 0) return changed;

    for (const [id, client] of b.clients) {
      if (id !== fromClient) client.send({ type: 'update', board, elements: changed });
    }
    const change: HubChange = { board, from: fromClient, elements: changed };
    for (const l of this.listeners) if (l.board === undefined || l.board === board) l.fn(change);
    return changed;
  }

  /** The Mac renderer and Claude's draws enter here. */
  local(board: string, elements: readonly SyncElement[]): SyncElement[] {
    return this.apply(board, MAC_CLIENT, elements);
  }

  /** Fires after each merge that changed something. Without a board name it watches all boards. */
  onChange(fn: (change: HubChange) => void): () => void;
  onChange(board: string, fn: (change: HubChange) => void): () => void;
  onChange(a: string | ((c: HubChange) => void), b?: (c: HubChange) => void): () => void {
    const entry = typeof a === 'string' ? { board: a, fn: b! } : { fn: a };
    this.listeners.add(entry);
    return () => this.listeners.delete(entry);
  }
}
