/**
 * Updates from GitHub releases. Background checks run at launch and every
 * few hours, download a newer build, and install it on quit or when the user
 * picks Restart to Update. A check the user asks for checks, downloads and
 * restarts in one step.
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
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => { unref?(): void };
}

export const FIRST_CHECK_MS = 10_000;
export const CHECK_EVERY_MS = 6 * 3600_000;

export class Updater {
  private status: UpdateStatus;
  private checking?: Promise<UpdateStatus>;

  constructor(private readonly opts: UpdaterOptions) {
    this.status = { version: opts.version, state: opts.source ? 'idle' : 'off' };
    const source = opts.source;
    if (!source) return;
    source.autoDownload = true;
    source.autoInstallOnAppQuit = true;
    source.on('checking-for-update', () => this.publish({ state: 'checking', error: undefined }));
    source.on('update-not-available', () =>
      this.publish({ state: 'current', checkedAt: this.now(), restart: undefined }),
    );
    source.on('update-available', (info) =>
      this.publish({ state: 'downloading', available: info.version, percent: 0, checkedAt: this.now() }),
    );
    source.on('download-progress', (p) => this.publish({ state: 'downloading', percent: Math.round(p.percent) }));
    source.on('update-downloaded', (info) => {
      this.publish({ state: 'ready', available: info.version, percent: undefined });
      if (this.status.restart) void this.install();
    });
    source.on('error', (err) =>
      this.publish({ state: 'error', error: err.message, percent: undefined, restart: undefined }),
    );
  }

  current(): UpdateStatus {
    return this.status;
  }

  /** Checks after a short delay, then on a fixed interval. */
  schedule(): void {
    if (!this.opts.source) return;
    const setTimer = this.opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    const loop = (ms: number) => {
      setTimer(() => {
        void this.check();
        loop(CHECK_EVERY_MS);
      }, ms).unref?.();
    };
    loop(FIRST_CHECK_MS);
  }

  /** Checks now. A downloaded update stays ready, so a later check never hides it. */
  check(): Promise<UpdateStatus> {
    const source = this.opts.source;
    if (!source || this.status.state === 'ready') return Promise.resolve(this.status);
    this.checking ??= source
      .checkForUpdates()
      .catch((err: unknown) => this.publish({ state: 'error', error: (err as Error).message }))
      .then(() => this.status)
      .finally(() => (this.checking = undefined));
    return this.checking;
  }

  /**
   * Updates now, as the user asked. A ready update installs at once. Otherwise
   * it checks, and the app restarts as soon as a newer build finishes downloading.
   */
  update(): Promise<UpdateStatus> {
    if (!this.opts.source) return Promise.resolve(this.status);
    if (this.status.state === 'ready') return this.install().then(() => this.status);
    this.publish({ restart: true });
    if (this.status.state === 'downloading') return Promise.resolve(this.status);
    return this.check();
  }

  async install(): Promise<void> {
    if (!this.opts.source || this.status.state !== 'ready') return;
    await this.opts.beforeInstall();
    this.opts.source.quitAndInstall();
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
