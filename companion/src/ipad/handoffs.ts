/** Hand-offs the iPad answers, each tied to one session, kept across restarts. */

import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Handoff } from '../protocol';
import type { IpadDeliveryResult } from '../shared/ipad';

const FILE_VERSION = 1;

/** A settled hand-off stays this long, so a late outbox retry still gets its first answer. */
const SETTLED_KEEP_MS = 30 * 24 * 3600_000;

export interface StoredHandoff extends Handoff {
  /** The board the iPad starts from. */
  baseBoard?: string;
  /** What `baseBoard` held at hand-off. Send updates that board only while it still holds this. */
  baseMark?: string;
  /** The project folder a page hand-off's files load from. */
  pageRoot?: string;
  /** Each iPad's answer, by device id. */
  results?: Record<string, IpadDeliveryResult>;
  settledAt?: number;
}

/**
 * Identifies a board's drawing and notes. Excalidraw bumps an element's version on each change,
 * so this ignores the view and how the file was written. Undefined for a scene it cannot read.
 */
export function boardMark(board: { scene: string | null; notes: string }): string | undefined {
  try {
    const elements = (JSON.parse(board.scene ?? '') as { elements: { id: string; version?: number; isDeleted?: boolean }[] }).elements;
    const drawn = elements.filter((e) => !e.isDeleted).map((e) => `${e.id}:${e.version ?? 0}`).sort();
    return createHash('sha256').update(JSON.stringify([drawn, board.notes])).digest('base64url');
  } catch {
    return undefined;
  }
}

export function publicHandoff(h: StoredHandoff): Handoff {
  const { baseBoard: _base, baseMark: _mark, pageRoot: _root, results: _results, settledAt: _settled, ...rest } = h;
  return rest;
}

export class HandoffStore {
  private readonly items = new Map<string, StoredHandoff>();
  private readonly now: () => number;

  constructor(private readonly opts: { file: string; now?: () => number }) {
    this.now = opts.now ?? Date.now;
    try {
      const data = JSON.parse(readFileSync(opts.file, 'utf8')) as { version?: unknown; handoffs?: unknown };
      if (data?.version === FILE_VERSION && Array.isArray(data.handoffs)) {
        for (const h of data.handoffs as StoredHandoff[]) {
          if (typeof h?.id === 'string' && typeof h.sessionId === 'string' && typeof h.boardName === 'string') this.items.set(h.id, h);
        }
      }
    } catch {
      // A missing or unreadable file starts an empty list.
    }
    if (this.prune()) this.save();
  }

  create(fields: { sessionId: string; sessionLabel: string; prompt?: string; baseBoard?: string; baseMark?: string; page?: string; pageRoot?: string }): StoredHandoff {
    const id = randomBytes(4).toString('hex');
    const handoff: StoredHandoff = {
      id,
      sessionId: fields.sessionId,
      sessionLabel: fields.sessionLabel,
      ...(fields.prompt ? { prompt: fields.prompt } : {}),
      boardName: `ipad-${id}`,
      ...(fields.baseBoard ? { fromBoard: fields.baseBoard } : {}),
      createdAt: this.now(),
      state: 'open',
      ...(fields.baseBoard ? { baseBoard: fields.baseBoard } : {}),
      ...(fields.baseMark ? { baseMark: fields.baseMark } : {}),
      ...(fields.page && fields.pageRoot ? { page: fields.page, pageRoot: fields.pageRoot } : {}),
    };
    this.items.set(id, handoff);
    this.save();
    return handoff;
  }

  get(id: string): StoredHandoff | undefined {
    return this.items.get(id);
  }

  /** Newest first. */
  list(filter: { sessionId?: string; open?: boolean } = {}): StoredHandoff[] {
    return [...this.items.values()]
      .filter((h) => (filter.sessionId === undefined || h.sessionId === filter.sessionId) && (!filter.open || h.state === 'open'))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  settle(id: string, deviceId: string, result: IpadDeliveryResult): void {
    const h = this.items.get(id);
    if (!h) return;
    h.state = result.state;
    h.results = { ...h.results, [deviceId]: result };
    h.settledAt = this.now();
    this.save();
  }

  remove(id: string): boolean {
    if (!this.items.delete(id)) return false;
    this.save();
    return true;
  }

  private prune(): boolean {
    let dropped = false;
    for (const [id, h] of this.items) {
      if (h.settledAt !== undefined && this.now() - h.settledAt > SETTLED_KEEP_MS) dropped = this.items.delete(id) || dropped;
    }
    return dropped;
  }

  private save(): void {
    const tmp = `${this.opts.file}.tmp`;
    mkdirSync(dirname(this.opts.file), { recursive: true });
    writeFileSync(tmp, JSON.stringify({ version: FILE_VERSION, handoffs: [...this.items.values()] }, null, 2), { mode: 0o600 });
    renameSync(tmp, this.opts.file);
  }
}
