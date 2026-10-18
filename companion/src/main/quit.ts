/**
 * The quit sequence. The first quit waits while the renderer saves and the
 * socket closes, then quits for real. Each step has a deadline, and a quit
 * that something cancels after that still exits, so the app always goes.
 */

/** Longest wait for the renderer to write pending saves. */
export const FLUSH_MS = 5000;
/** Longest wait for the socket server to close. */
export const CLOSE_MS = 1000;
/** Time a prepared quit gets to finish before the app exits anyway. */
export const EXIT_MS = 3000;

type SetTimer = (fn: () => void, ms: number) => unknown;

export interface QuitterOptions {
  /** Asks the renderer to write pending saves. */
  flush: () => Promise<unknown>;
  closeServer: () => Promise<unknown>;
  /** `app.quit`, which emits `before-quit` again. */
  quit: () => void;
  /** `app.exit`, which skips every quit handler. */
  exit: () => void;
  setTimer?: SetTimer;
}

/** Resolves once `run` settles or `ms` passes. Never rejects. */
export function settleWithin(run: () => Promise<unknown>, ms: number, setTimer: SetTimer = setTimeout): Promise<void> {
  return new Promise((resolve) => {
    setTimer(resolve, ms);
    Promise.resolve()
      .then(run)
      .then(
        () => resolve(),
        () => resolve(),
      );
  });
}

export class Quitter {
  private running?: Promise<void>;
  private ready = false;
  private exitArmed = false;

  constructor(private readonly opts: QuitterOptions) {}

  get prepared(): boolean {
    return this.ready;
  }

  /** Saves and closes the socket once. Later calls share the first run. */
  prepare(): Promise<void> {
    const setTimer = this.opts.setTimer ?? setTimeout;
    this.running ??= settleWithin(this.opts.flush, FLUSH_MS, setTimer)
      .then(() => settleWithin(this.opts.closeServer, CLOSE_MS, setTimer))
      .then(() => {
        this.ready = true;
      });
    return this.running;
  }

  /** Handles `before-quit`. Holds the first quit until `prepare` ends, then lets quits through. */
  beforeQuit(e: { preventDefault(): void }): void {
    if (this.ready) return this.armExit();
    e.preventDefault();
    void this.prepare().then(() => this.opts.quit());
  }

  /** Exits if the quit has not finished in time, as when a window refuses to close. */
  private armExit(): void {
    if (this.exitArmed) return;
    this.exitArmed = true;
    const setTimer = this.opts.setTimer ?? setTimeout;
    setTimer(() => this.opts.exit(), EXIT_MS);
  }
}
