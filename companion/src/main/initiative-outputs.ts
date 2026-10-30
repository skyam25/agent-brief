/**
 * Files the ready outputs of live sessions attached to an initiative in its brief's Outputs.
 *
 * Each attached session's outputs file is watched. A change, or a new attachment, reads the
 * file and hands its records to the store, which adds the rows the brief lacks.
 */

import { readFileSync } from 'node:fs';
import { outputsFile, type OutputRecord, type SessionInfo } from '../protocol';
import { parseOutputsFile } from '../shared/outputs';
import { ItemsWatcher, type ItemsWatchOptions } from './items-watch';

export interface InitiativeOutputsStore {
  attached(sessionId: string): string | undefined;
  recordOutputs(sessionId: string, cwd: string, records: readonly OutputRecord[]): boolean;
}

export class InitiativeOutputs {
  private readonly watcher: ItemsWatcher;

  constructor(
    private readonly store: InitiativeOutputsStore,
    private readonly live: () => readonly SessionInfo[],
    opts: ItemsWatchOptions = {},
  ) {
    this.watcher = new ItemsWatcher((sessionId) => this.record(sessionId), opts);
  }

  /** Watches exactly the live attached sessions. A newly watched one files what it has now. */
  sync(): void {
    const before = this.watcher.watched();
    const want = new Map(
      this.live()
        .filter((s) => s.cwd && this.store.attached(s.sessionId))
        .map((s) => [s.sessionId, outputsFile(s.cwd, s.sessionId)]),
    );
    this.watcher.sync(want);
    for (const id of want.keys()) if (!before.has(id)) this.record(id);
  }

  close(): void {
    this.watcher.close();
  }

  private record(sessionId: string): void {
    const cwd = this.live().find((s) => s.sessionId === sessionId)?.cwd;
    if (!cwd) return;
    let text: string;
    try {
      text = readFileSync(outputsFile(cwd, sessionId), 'utf8');
    } catch {
      return;
    }
    const records = parseOutputsFile(text)?.outputs ?? [];
    try {
      this.store.recordOutputs(sessionId, cwd, records);
    } catch (err) {
      console.warn(`[companion] could not file the outputs of ${sessionId}: ${(err as Error).message}`);
    }
  }
}
