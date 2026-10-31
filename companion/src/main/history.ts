/** The last sends: `<dataDir>/history/index.json` plus a folder per send with its PNG and scene, when it had a sketch. */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HistoryEntry } from '../shared/ipc';
import { writeAtomic } from './files';

export const HISTORY_LIMIT = 10;

const ID = /^[\w-]+$/;

export class SendHistory {
  readonly dir: string;
  private readonly indexPath: string;
  private entries: HistoryEntry[];

  constructor(
    dataDir: string,
    private readonly limit = HISTORY_LIMIT,
  ) {
    this.dir = join(dataDir, 'history');
    this.indexPath = join(this.dir, 'index.json');
    mkdirSync(this.dir, { recursive: true });
    try {
      this.entries = JSON.parse(readFileSync(this.indexPath, 'utf8'));
    } catch {
      this.entries = [];
    }
  }

  /** Newest first. */
  list(): HistoryEntry[] {
    return [...this.entries];
  }

  get(id: string): HistoryEntry | undefined {
    return this.entries.find((e) => e.id === id);
  }

  /** Records a send and drops the oldest ones past the limit. */
  add(entry: HistoryEntry, files: { png?: Buffer; scene?: unknown }): void {
    if (!ID.test(entry.id)) throw new Error(`bad history id ${JSON.stringify(entry.id)}`);
    const folder = join(this.dir, entry.id);
    mkdirSync(folder, { recursive: true });
    if (files.png) {
      writeFileSync(join(folder, 'sketch.png'), files.png);
      writeFileSync(join(folder, 'board.excalidraw'), JSON.stringify(files.scene));
    }
    this.entries = [entry, ...this.entries.filter((e) => e.id !== entry.id)].slice(0, this.limit);
    this.save();
    this.prune();
  }

  png(id: string): Buffer | undefined {
    return this.read(id, 'sketch.png');
  }

  scene(id: string): string | undefined {
    return this.read(id, 'board.excalidraw')?.toString('utf8');
  }

  private read(id: string, file: string): Buffer | undefined {
    if (!this.get(id)) return undefined;
    const path = join(this.dir, id, file);
    return existsSync(path) ? readFileSync(path) : undefined;
  }

  private save(): void {
    writeAtomic(this.indexPath, JSON.stringify(this.entries, null, 2));
  }

  /** Removes every folder the index no longer lists. */
  private prune(): void {
    const keep = new Set(this.entries.map((e) => e.id));
    for (const name of readdirSync(this.dir, { withFileTypes: true })) {
      if (name.isDirectory() && !keep.has(name.name)) rmSync(join(this.dir, name.name), { recursive: true, force: true });
    }
  }
}

/** A free board name for a restored send, like `scratch 11.37` or `scratch 11.37 2`. */
export function restoredBoardName(board: string, sentAt: number, exists: (name: string) => boolean): string {
  const d = new Date(sentAt);
  const time = `${String(d.getHours()).padStart(2, '0')}.${String(d.getMinutes()).padStart(2, '0')}`;
  const base = `${board.slice(0, 64 - time.length - 4)} ${time}`;
  let name = base;
  for (let n = 2; exists(name); n++) name = `${base} ${n}`;
  return name;
}
