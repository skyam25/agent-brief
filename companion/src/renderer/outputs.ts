/** Holds each session's outputs as main reads them from the mod's outputs file. */

import type { CompanionApi, OutputsInfo } from '../shared/ipc';

type OutputsHost = Pick<CompanionApi, 'readOutputs' | 'onOutputs'>;

export class OutputsStore {
  /** Bumps on every change, as the snapshot React compares. */
  version = 0;
  private readonly infos = new Map<string, OutputsInfo>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly host: OutputsHost) {
    host.onOutputs((info) => this.put(info));
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    this.version++;
    for (const fn of this.listeners) fn();
  }

  private put(info: OutputsInfo): void {
    this.infos.set(info.sessionId, info);
    this.emit();
  }

  /** Reads the session's file from disk. */
  async load(sessionId: string): Promise<void> {
    const info = await this.host.readOutputs(sessionId);
    if (info) this.put(info);
  }

  info(sessionId: string): OutputsInfo | undefined {
    return this.infos.get(sessionId);
  }
}
