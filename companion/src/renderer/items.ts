/** Holds each session's items file and the decisions typed on it but not sent yet. */

import type { CompanionApi, Decision, ItemsDocInfo } from '../shared/ipc';

type ItemsHost = Pick<CompanionApi, 'readItems' | 'onItems'>;

export class ItemsStore {
  /** Bumps on every change, as the snapshot React compares. */
  version = 0;
  private readonly docs = new Map<string, ItemsDocInfo>();
  /** Unsent decisions by session, then by item number. */
  private readonly typed = new Map<string, Map<number, string>>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly host: ItemsHost) {
    host.onItems((info) => this.put(info));
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    this.version++;
    for (const fn of this.listeners) fn();
  }

  private put(info: ItemsDocInfo): void {
    this.docs.set(info.sessionId, info);
    this.emit();
  }

  /** Reads the session's file from disk. */
  async load(sessionId: string): Promise<void> {
    const info = await this.host.readItems(sessionId);
    if (info) this.put(info);
  }

  doc(sessionId: string): ItemsDocInfo | undefined {
    return this.docs.get(sessionId);
  }

  decision(sessionId: string, n: number): string {
    return this.typed.get(sessionId)?.get(n) ?? '';
  }

  setDecision(sessionId: string, n: number, text: string): void {
    let byItem = this.typed.get(sessionId);
    if (!byItem) this.typed.set(sessionId, (byItem = new Map()));
    if (text) byItem.set(n, text);
    else byItem.delete(n);
    this.emit();
  }

  /** Non-empty decisions on items still open in the file, in file order. */
  decisions(sessionId: string): Decision[] {
    const byItem = this.typed.get(sessionId);
    const items = this.docs.get(sessionId)?.doc.items ?? [];
    if (!byItem) return [];
    return items
      .filter((item) => !item.done && byItem.get(item.n)?.trim())
      .map((item) => ({ n: item.n, text: byItem.get(item.n)!.trim() }));
  }

  /** Forgets the decisions a Send delivered. A field edited since keeps its new text. */
  clear(sessionId: string, sent: Decision[]): void {
    const byItem = this.typed.get(sessionId);
    if (!byItem) return;
    for (const d of sent) if (byItem.get(d.n)?.trim() === d.text) byItem.delete(d.n);
    this.emit();
  }
}
