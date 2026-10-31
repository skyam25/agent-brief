/**
 * Updates from GitHub releases. Background checks run at launch, every few
 * hours and after the Mac wakes, download a newer build, and install it on
 * quit or when the user picks Restart to Update. A failed check tries again
 * on its own. A check the user asks for checks and downloads, then asks
 * before it restarts.
 */

import type { UpdateStatus } from '../shared/ipc';

/** The part of electron-updater's `autoUpdater` this module uses. */
export interface UpdateSource {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  on(event: 'checking-for-update' | 'update-not-available', fn: () => void): unknown;
  on(event: 'update-available' | 'update-downloaded', fn: (info: { version: string }) => void): unknown;
  on(event: 'download-progress', fn: (p: { percent: number }) => void): unknown;
  on(event: 'error', fn: (err: Error) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(): void;
}

export interface UpdaterOptions {
  version: string;
  /** Undefined turns updates off, as in development and test runs. */
  source?: UpdateSource;
  onStatus: (status: UpdateStatus) => void;
  /** Saves boards and lets windows close before the app quits for the install. */
  beforeInstall: () => Promise<void>;
  /** Asks whether to restart into `version` now. False leaves it to install on quit. */
  confirmRestart: (version: string) => Promise<boolean>;
  /**
   * Squirrel's own `update-downloaded` on macOS. electron-updater reports a
   * download before Squirrel unpacks and verifies it, so ready waits for this
   * and Restart to Update installs at once.
   */
  staged?: (fn: () => void) => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => { unref?(): void };
}

export const FIRST_CHECK_MS = 10_000;
export const CHECK_EVERY_MS = 6 * 3600_000;

/** How often the schedule reads the clock. Timers pause while the Mac sleeps, so due times use the wall clock. */
export const TICK_MS = 10 * 60_000;

/** A failed check tries again after this long. */
export const RETRY_MS = 15 * 60_000;

/** Gives the network time to come back after the Mac wakes. */
export const RESUME_DELAY_MS = 30_000;

export class Updater {
  private status: UpdateStatus;
  private checking?: Promise<UpdateStatus>;
  private asking = false;
  private lastCheck?: number;

  constructor(private readonly opts: UpdaterOptions) {
    this.status = { version: opts.version, state: opts.source ? 'idle' : 'off' };
    const source = opts.source;
    if (!source) return;
    source.autoDownload = true;
    source.autoInstallOnAppQuit = true;
    source.on('checking-for-update', () => this.publish({ state: 'checking', error: undefined, available: undefined }));
    source.on('update-not-available', () =>
      this.publish({ state: 'current', checkedAt: this.now(), restart: undefined }),
    );
    source.on('update-available', (info) =>
      this.publish({ state: 'downloading', available: info.version, percent: 0, checkedAt: this.now() }),
    );
    source.on('download-progress', (p) => this.publish({ state: 'downloading', percent: Math.round(p.percent) }));
    source.on('update-downloaded', (info) => {
      if (opts.staged) this.publish({ state: 'downloading', available: info.version, percent: 100 });
      else this.ready(info.version);
    });
    opts.staged?.(() => {
      if (this.status.state === 'downloading') this.ready(this.status.available ?? '');
    });
    source.on('error', (err) => this.fail(err));
  }

  current(): UpdateStatus {
    return this.status;
  }

  /** Checks after a short delay, then whenever a check falls due. */
  schedule(): void {
    if (!this.opts.source) return;
    const tick = (ms: number) => {
      this.setTimer(() => {
        this.checkIfDue();
        tick(TICK_MS);
      }, ms);
    };
    tick(FIRST_CHECK_MS);
  }

  /** The Mac woke. Checks once the network is back, if a check is due. */
  resumed(): void {
    if (this.opts.source) this.setTimer(() => this.checkIfDue(), RESUME_DELAY_MS);
  }

  /** Checks now. A downloaded update stays ready, so a later check never hides it. */
  check(): Promise<UpdateStatus> {
    const source = this.opts.source;
    if (!source || this.status.state === 'ready') return Promise.resolve(this.status);
    if (!this.checking) this.lastCheck = this.now();
    this.checking ??= source
      .checkForUpdates()
      .catch((err: unknown) => this.fail(err as Error))
      .then(() => this.status)
      .finally(() => (this.checking = undefined));
    return this.checking;
  }

  /**
   * Updates as the user asked. A ready update asks to restart now. Otherwise it
   * checks, and asks once a newer build finishes downloading.
   */
  update(): Promise<UpdateStatus> {
    if (!this.opts.source) return Promise.resolve(this.status);
    if (this.status.state === 'ready') return this.offerRestart().then(() => this.status);
    this.publish({ restart: true });
    if (this.status.state === 'downloading') return Promise.resolve(this.status);
    return this.check();
  }

  async install(): Promise<void> {
    if (!this.opts.source || this.status.state !== 'ready') return;
    await this.opts.beforeInstall();
    this.opts.source.quitAndInstall();
  }

  /** First thing, six hours after a good check, fifteen minutes after a failed one. Never during a download. */
  private checkIfDue(): void {
    const { state } = this.status;
    if (state === 'checking' || state === 'downloading' || state === 'ready') return;
    const wait = state === 'error' ? RETRY_MS : CHECK_EVERY_MS;
    if (this.lastCheck === undefined || this.now() - this.lastCheck >= wait) void this.check();
  }

  private ready(version: string): void {
    const asked = this.status.restart;
    this.publish({ state: 'ready', available: version, percent: undefined, restart: undefined });
    if (asked) void this.offerRestart();
  }

  /** A download that fails keeps its version, so the status can say which one. A staged update stays ready. */
  private fail(err: Error): void {
    if (this.status.state === 'ready') return;
    const available = this.status.state === 'downloading' ? this.status.available : undefined;
    this.publish({ state: 'error', error: err.message, available, percent: undefined, restart: undefined });
  }

  /** One question at a time, so a second click never stacks dialogs. */
  private async offerRestart(): Promise<void> {
    if (this.asking || this.status.state !== 'ready') return;
    this.asking = true;
    try {
      if (await this.opts.confirmRestart(this.status.available ?? '')) await this.install();
    } finally {
      this.asking = false;
    }
  }

  private setTimer(fn: () => void, ms: number): void {
    (this.opts.setTimer ?? ((f, t) => setTimeout(f, t)))(fn, ms).unref?.();
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  private publish(patch: Partial<UpdateStatus>): UpdateStatus {
    this.status = { ...this.status, ...patch };
    this.opts.onStatus(this.status);
    return this.status;
  }
}
