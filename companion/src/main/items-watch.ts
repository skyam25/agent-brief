/**
 * Watches tracked sessions' items files and reports when one changes or appears.
 *
 * Each file's folder is watched with fs.watch once it exists. Until then, and
 * after the folder goes away, a poll checks the file's mtime and size.
 */

import { existsSync, statSync, watch, type FSWatcher } from 'node:fs';
import { basename, dirname } from 'node:path';

export interface ItemsWatchOptions {
  debounceMs?: number;
  pollMs?: number;
}

interface Entry {
  path: string;
  /** The file's mtime and size when last seen, or `none`. */
  seen: string;
  watcher?: FSWatcher;
  poll?: NodeJS.Timeout;
  debounce?: NodeJS.Timeout;
}

const signature = (path: string): string => {
  try {
    const s = statSync(path);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return 'none';
  }
};

export class ItemsWatcher {
  private readonly entries = new Map<string, Entry>();
  private readonly debounceMs: number;
  private readonly pollMs: number;

  constructor(
    private readonly onChange: (sessionId: string) => void,
    opts: ItemsWatchOptions = {},
  ) {
    this.debounceMs = opts.debounceMs ?? 200;
    this.pollMs = opts.pollMs ?? 1500;
  }

  /** The sessions watched now, with their paths. */
  watched(): Map<string, string> {
    return new Map([...this.entries].map(([id, e]) => [id, e.path]));
  }

  /** Watches exactly these sessions: starts new ones, stops the rest, restarts any whose path moved. */
  sync(want: Map<string, string>): void {
    for (const [id, e] of this.entries) if (want.get(id) !== e.path) this.unwatch(id);
    for (const [id, path] of want) if (!this.entries.has(id)) this.watch(id, path);
  }

  close(): void {
    for (const id of [...this.entries.keys()]) this.unwatch(id);
  }

  /** Takes every watched file as it is now, so a change already made reports nothing. */
  settle(): void {
    for (const e of this.entries.values()) e.seen = signature(e.path);
  }

  private watch(sessionId: string, path: string): void {
    const entry: Entry = { path, seen: signature(path) };
    this.entries.set(sessionId, entry);
    this.attach(sessionId, entry);
  }

  private unwatch(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    this.detach(entry);
    clearTimeout(entry.debounce);
    this.entries.delete(sessionId);
  }

  /** Watches the folder when it exists, else polls until it does. */
  private attach(sessionId: string, entry: Entry): void {
    const dir = dirname(entry.path);
    if (existsSync(dir)) {
      try {
        const name = basename(entry.path);
        entry.watcher = watch(dir, (_event, file) => {
          if (file === null || file.toString() === name) this.changed(sessionId, entry);
          if (!existsSync(dir)) this.fallBack(sessionId, entry);
        });
        entry.watcher.on('error', () => this.fallBack(sessionId, entry));
        return;
      } catch {
        // The folder went away between the check and the watch, so poll.
      }
    }
    entry.poll = setInterval(() => {
      if (existsSync(dir)) {
        this.detach(entry);
        this.attach(sessionId, entry);
      }
      if (signature(entry.path) !== entry.seen) this.changed(sessionId, entry);
    }, this.pollMs);
    entry.poll.unref?.();
  }

  private fallBack(sessionId: string, entry: Entry): void {
    if (this.entries.get(sessionId) !== entry) return;
    this.detach(entry);
    this.attach(sessionId, entry);
  }

  private detach(entry: Entry): void {
    entry.watcher?.close();
    entry.watcher = undefined;
    clearInterval(entry.poll);
    entry.poll = undefined;
  }

  /** Reports the file after the debounce when its mtime or size differs from what was last reported. */
  private changed(sessionId: string, entry: Entry): void {
    clearTimeout(entry.debounce);
    entry.debounce = setTimeout(() => {
      entry.debounce = undefined;
      if (this.entries.get(sessionId) !== entry) return;
      const now = signature(entry.path);
      if (now === entry.seen) return;
      entry.seen = now;
      this.onChange(sessionId);
    }, this.debounceMs);
    entry.debounce.unref?.();
  }
}
