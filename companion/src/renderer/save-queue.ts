/** Keyed autosaves: debounce edits, serialize each record, retry failures and drain on flush. */
export class SaveQueue {
  error?: string;
  private readonly pending = new Set<string>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly running = new Map<string, { done: Promise<void>; cancelled: boolean }>();

  constructor(
    /** True when persisted, false when the store intentionally skips a missing/invalid record. */
    private readonly write: (id: string) => Promise<boolean>,
    private readonly onErrorChange: () => void,
    private readonly delayMs = 400,
    private readonly retryMs = 2000,
  ) {}

  /** Queued or in-flight changes must win over a stale read from disk. */
  has(id: string): boolean {
    return this.pending.has(id) || this.running.has(id);
  }

  schedule(id: string, delay = this.delayMs): void {
    this.pending.add(id);
    clearTimeout(this.timers.get(id));
    this.timers.set(id, setTimeout(() => {
      this.timers.delete(id);
      void this.run(id);
    }, delay));
  }

  /** Cancels queued work and prevents a removed record's failed write from retrying. */
  cancel(id: string): void {
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    this.pending.delete(id);
    const active = this.running.get(id);
    if (active) active.cancelled = true;
  }

  /** Waits for active writes too. Failures get one immediate retry, then remain queued. */
  async flush(): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const ids = new Set([...this.pending, ...this.running.keys()]);
      if (ids.size === 0) return;
      for (const timer of this.timers.values()) clearTimeout(timer);
      this.timers.clear();
      await Promise.all([...ids].map((id) => this.run(id)));
    }
  }

  private async run(id: string): Promise<void> {
    // Timer and flush callers can meet here; only one write of a record may run at once.
    while (this.running.has(id)) await this.running.get(id)!.done;
    if (!this.pending.delete(id)) return;
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    const active = { done: Promise.resolve(), cancelled: false };
    this.running.set(id, active);
    active.done = Promise.resolve()
      .then(() => this.write(id))
      .then((saved) => {
        if (saved && !active.cancelled && this.error && this.pending.size === 0) {
          this.error = undefined;
          this.onErrorChange();
        }
      })
      .catch((err: unknown) => {
        if (active.cancelled) return;
        this.error = err instanceof Error ? err.message : String(err);
        // A newer edit keeps its own debounce rather than waiting for the retry delay.
        if (!this.pending.has(id)) this.schedule(id, this.retryMs);
        this.onErrorChange();
      })
      .finally(() => { this.running.delete(id); });
    await active.done;
  }
}
