/**
 * Watches the outputs the panel shows, and their feedback files, while they show.
 *
 * Each open view counts, so the watch holds until the last view of an output closes.
 * `settle` takes the files as they are now, so the app's own writes report nothing.
 */

import { ItemsWatcher, type ItemsWatchOptions } from './items-watch';

export type WatchedKind = 'output' | 'feedback';

/** The files behind an output. `output` is absent when only its feedback file matters. */
export interface WatchedFiles {
  output?: string;
  feedback: string;
}

interface Watched {
  sessionId: string;
  path: string;
  files: WatchedFiles;
  views: number;
}

const SEP = '\u0000';

export class OutputWatch {
  private readonly watched = new Map<string, Watched>();
  private readonly files: ItemsWatcher;

  constructor(
    private readonly resolve: (sessionId: string, path: string) => WatchedFiles,
    onChange: (sessionId: string, path: string, kind: WatchedKind) => void,
    opts: ItemsWatchOptions = {},
  ) {
    this.files = new ItemsWatcher((id) => {
      const at = id.lastIndexOf(SEP);
      const w = this.watched.get(id.slice(0, at));
      if (w) onChange(w.sessionId, w.path, id.slice(at + 1) as WatchedKind);
    }, opts);
  }

  /** Throws when the resolver refuses the path. */
  watch(sessionId: string, path: string): void {
    const key = sessionId + SEP + path;
    const w = this.watched.get(key);
    if (w) {
      w.views++;
      return;
    }
    this.watched.set(key, { sessionId, path, files: this.resolve(sessionId, path), views: 1 });
    this.sync();
  }

  unwatch(sessionId: string, path: string): void {
    const key = sessionId + SEP + path;
    const w = this.watched.get(key);
    if (!w || --w.views > 0) return;
    this.watched.delete(key);
    this.sync();
  }

  settle(): void {
    this.files.settle();
  }

  /** Stops every watch, as when the panel reloads and its views start over. */
  clear(): void {
    this.watched.clear();
    this.files.close();
  }

  private sync(): void {
    const want = new Map<string, string>();
    for (const [key, w] of this.watched) {
      if (w.files.output) want.set(`${key}${SEP}output`, w.files.output);
      want.set(`${key}${SEP}feedback`, w.files.feedback);
    }
    this.files.sync(want);
  }
}
