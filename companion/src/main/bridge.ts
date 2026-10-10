/** Request/response calls from main into the renderer, matched by id. */

import type { WebContents } from 'electron';
import { BoardError } from '../board/errors';
import { CH, type BoardOpName, type BoardOps, type BoardReply } from '../shared/ipc';

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class RendererBridge {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readyPromise!: Promise<void>;
  private markReady!: () => void;

  constructor(private readonly contents: () => WebContents | undefined) {
    this.reset();
  }

  /** Call when the renderer starts loading. Fails calls in flight and waits for a new ready. */
  reset(): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new BoardError('unavailable', 'panel reloaded'));
      this.pending.delete(id);
    }
    this.readyPromise = new Promise((resolve) => {
      this.markReady = resolve;
    });
  }

  ready(): void {
    this.markReady();
  }

  async request<K extends BoardOpName>(
    op: K,
    args: BoardOps[K]['args'],
    timeoutMs = 20_000,
  ): Promise<BoardOps[K]['result']> {
    const waited = await Promise.race([
      this.readyPromise.then(() => true),
      new Promise<false>((r) => setTimeout(() => r(false), timeoutMs)),
    ]);
    const wc = this.contents();
    if (!waited || !wc || wc.isDestroyed()) throw new BoardError('unavailable', 'panel is not ready');
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BoardError('unavailable', `panel did not answer ${op} in ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      wc.send(CH.request, { id, op, args });
    });
  }

  handleReply(reply: BoardReply): void {
    const p = this.pending.get(reply.id);
    if (!p) return;
    this.pending.delete(reply.id);
    clearTimeout(p.timer);
    if (reply.ok) {
      p.resolve(reply.result);
    } else {
      const code = reply.error.code;
      const known = code === 'not_found' || code === 'bad_request' || code === 'conflict' || code === 'unavailable';
      p.reject(new BoardError(known ? code : 'internal', reply.error.message));
    }
  }
}
