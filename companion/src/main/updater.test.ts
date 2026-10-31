import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { UpdateStatus } from '../shared/ipc';
import {
  CHECK_EVERY_MS,
  FIRST_CHECK_MS,
  RESUME_DELAY_MS,
  RETRY_MS,
  TICK_MS,
  Updater,
  type UpdateSource,
} from './updater';

class FakeSource extends EventEmitter implements UpdateSource {
  autoDownload = false;
  autoInstallOnAppQuit = false;
  checks = 0;
  installs = 0;
  /** What the next check does. */
  next: 'none' | 'available' | 'fail' = 'none';

  async checkForUpdates() {
    this.checks += 1;
    this.emit('checking-for-update');
    if (this.next === 'fail') {
      this.emit('error', new Error('offline'));
      throw new Error('offline');
    }
    if (this.next === 'none') return void this.emit('update-not-available');
    this.emit('update-available', { version: '0.2.0' });
    this.emit('download-progress', { percent: 41.6 });
  }

  quitAndInstall() {
    this.installs += 1;
  }
}

const quiet = { onStatus: () => {}, beforeInstall: async () => {}, confirmRestart: async () => true };

function setup(source = new FakeSource()) {
  const seen: UpdateStatus[] = [];
  const order: string[] = [];
  /** The user's answer to the restart question. */
  const answer = { now: true };
  const asked: string[] = [];
  const updater = new Updater({
    version: '0.1.1',
    source,
    onStatus: (s) => seen.push(s),
    beforeInstall: async () => void order.push('flush'),
    confirmRestart: async (version) => (asked.push(version), answer.now),
    now: () => 1000,
  });
  const install = source.quitAndInstall.bind(source);
  source.quitAndInstall = () => {
    order.push('install');
    install();
  };
  return { updater, source, seen, order, answer, asked };
}

describe('Updater', () => {
  it('is off without a source and never checks', async () => {
    const updater = new Updater({ version: '0.1.1', ...quiet });
    expect(updater.current()).toEqual({ version: '0.1.1', state: 'off' });
    expect(await updater.check()).toEqual({ version: '0.1.1', state: 'off' });
  });

  it('downloads in the background and installs on quit', () => {
    const { source } = setup();
    expect(source.autoDownload).toBe(true);
    expect(source.autoInstallOnAppQuit).toBe(true);
  });

  it('reports up to date', async () => {
    const { updater } = setup();
    expect(await updater.check()).toMatchObject({ state: 'current', checkedAt: 1000 });
  });

  it('reports download progress, then ready', async () => {
    const { updater, source, seen } = setup();
    source.next = 'available';
    expect(await updater.check()).toMatchObject({ state: 'downloading', available: '0.2.0', percent: 42 });
    source.emit('update-downloaded', { version: '0.2.0' });
    expect(updater.current()).toMatchObject({ state: 'ready', available: '0.2.0' });
    expect(seen.map((s) => s.state)).toEqual(['checking', 'downloading', 'downloading', 'ready']);
  });

  it('keeps a ready update when asked to check again', async () => {
    const { updater, source } = setup();
    source.emit('update-downloaded', { version: '0.2.0' });
    await updater.check();
    expect(source.checks).toBe(0);
    expect(updater.current().state).toBe('ready');
  });

  it('shares one check between overlapping calls', async () => {
    const { updater, source } = setup();
    await Promise.all([updater.check(), updater.check()]);
    expect(source.checks).toBe(1);
  });

  it('reports a failed check in words', async () => {
    const { updater, source } = setup();
    source.next = 'fail';
    expect(await updater.check()).toMatchObject({ state: 'error', error: 'offline' });
  });

  it('saves before it installs, and only a ready update', async () => {
    const { updater, source, order } = setup();
    await updater.install();
    expect(source.installs).toBe(0);
    source.emit('update-downloaded', { version: '0.2.0' });
    await updater.install();
    expect(order).toEqual(['flush', 'install']);
  });

  it('checks and downloads when the user asks, then restarts once they agree', async () => {
    const { updater, source, order, asked } = setup();
    source.next = 'available';
    expect(await updater.update()).toMatchObject({ state: 'downloading', restart: true });
    expect(source.installs).toBe(0);
    source.emit('update-downloaded', { version: '0.2.0' });
    await vi.waitFor(() => expect(order).toEqual(['flush', 'install']));
    expect(asked).toEqual(['0.2.0']);
  });

  it('keeps the update ready for quit when the user picks Later', async () => {
    const { updater, source, answer, asked } = setup();
    answer.now = false;
    source.next = 'available';
    await updater.update();
    source.emit('update-downloaded', { version: '0.2.0' });
    await vi.waitFor(() => expect(asked).toEqual(['0.2.0']));
    expect(source.installs).toBe(0);
    expect(source.autoInstallOnAppQuit).toBe(true);
    expect(updater.current()).toMatchObject({ state: 'ready', available: '0.2.0', restart: undefined });
  });

  it('asks after a background download the user asks for', async () => {
    const { updater, source, asked } = setup();
    source.next = 'available';
    await updater.check();
    expect(updater.current().restart).toBeUndefined();
    await updater.update();
    expect(source.checks).toBe(1);
    source.emit('update-downloaded', { version: '0.2.0' });
    await vi.waitFor(() => expect(source.installs).toBe(1));
    expect(asked).toEqual(['0.2.0']);
  });

  it('asks before it installs a ready update the user checks for', async () => {
    const { updater, source, answer, asked } = setup();
    source.emit('update-downloaded', { version: '0.2.0' });
    answer.now = false;
    await updater.update();
    expect(source.checks).toBe(0);
    expect(source.installs).toBe(0);
    answer.now = true;
    await updater.update();
    expect(asked).toEqual(['0.2.0', '0.2.0']);
    expect(source.installs).toBe(1);
  });

  it('never stacks a second question while one is open', async () => {
    const source = new FakeSource();
    let agree: (yes: boolean) => void = () => {};
    const confirmRestart = vi.fn(() => new Promise<boolean>((resolve) => (agree = resolve)));
    const updater = new Updater({ version: '0.1.1', source, ...quiet, confirmRestart });
    source.emit('update-downloaded', { version: '0.2.0' });
    const first = updater.update();
    await updater.update();
    expect(confirmRestart).toHaveBeenCalledTimes(1);
    agree(true);
    await first;
    expect(source.installs).toBe(1);
  });

  it('never asks after a background download nobody asked for', async () => {
    const { source, asked } = setup();
    source.emit('update-downloaded', { version: '0.2.0' });
    await Promise.resolve();
    expect(asked).toEqual([]);
    expect(source.installs).toBe(0);
  });

  it('waits for the next background download after nothing new or an error', async () => {
    const { updater, source } = setup();
    expect(await updater.update()).toMatchObject({ state: 'current', restart: undefined });
    source.next = 'fail';
    expect(await updater.update()).toMatchObject({ state: 'error', restart: undefined });
    source.next = 'available';
    await updater.check();
    source.emit('update-downloaded', { version: '0.2.0' });
    expect(source.installs).toBe(0);
  });

  /** A scheduled updater with a clock the test moves. `run` fires the timers that are due. */
  function scheduled(source = new FakeSource()) {
    const clock = { now: 0 };
    let timers: { fn: () => void; at: number; ms: number }[] = [];
    const updater = new Updater({
      version: '0.1.1',
      source,
      ...quiet,
      now: () => clock.now,
      setTimer: (fn, ms) => (timers.push({ fn, at: clock.now + ms, ms }), {}),
    });
    const run = (to: number) => {
      clock.now = to;
      const due = timers.filter((t) => t.at <= to);
      timers = timers.filter((t) => t.at > to);
      due.forEach((t) => t.fn());
    };
    return { updater, source, run, timers: () => timers };
  }

  it('checks soon after launch, then reads the clock on a short tick', () => {
    const { updater, source, run, timers } = scheduled();
    updater.schedule();
    expect(timers().map((t) => t.ms)).toEqual([FIRST_CHECK_MS]);
    run(FIRST_CHECK_MS);
    expect(source.checks).toBe(1);
    expect(timers().map((t) => t.ms)).toEqual([TICK_MS]);
  });

  it('checks again once six hours pass on the wall clock, however few ticks ran', async () => {
    const { updater, source, run } = scheduled();
    updater.schedule();
    run(FIRST_CHECK_MS);
    await updater.check();
    run(FIRST_CHECK_MS + TICK_MS);
    expect(source.checks).toBe(1);

    // The Mac slept, so the next tick lands long after it was due.
    run(FIRST_CHECK_MS + CHECK_EVERY_MS + 1);
    expect(source.checks).toBe(2);
  });

  it('tries a failed check again after a short wait', async () => {
    const { updater, source, run } = scheduled();
    source.next = 'fail';
    updater.schedule();
    run(FIRST_CHECK_MS);
    await new Promise((r) => setTimeout(r, 0));
    expect(updater.current().state).toBe('error');
    run(FIRST_CHECK_MS + TICK_MS);
    expect(source.checks).toBe(1);
    source.next = 'none';
    run(FIRST_CHECK_MS + TICK_MS * 2);
    expect(FIRST_CHECK_MS + TICK_MS * 2).toBeGreaterThanOrEqual(FIRST_CHECK_MS + RETRY_MS);
    expect(source.checks).toBe(2);
    await vi.waitFor(() => expect(updater.current().state).toBe('current'));
  });

  it('checks after the Mac wakes when a check is due', async () => {
    const { updater, source, run, timers } = scheduled();
    updater.resumed();
    expect(timers().map((t) => t.ms)).toEqual([RESUME_DELAY_MS]);
    run(RESUME_DELAY_MS);
    expect(source.checks).toBe(1);
    await updater.check();

    // A wake soon after a good check leaves it alone.
    updater.resumed();
    run(RESUME_DELAY_MS * 2);
    expect(source.checks).toBe(1);
  });

  it('never starts a scheduled check during a download', async () => {
    const { updater, source, run } = scheduled();
    source.next = 'available';
    await updater.check();
    updater.resumed();
    run(CHECK_EVERY_MS * 2);
    expect(source.checks).toBe(1);
  });

  it('waits for Squirrel to stage the update before it is ready', async () => {
    const source = new FakeSource();
    let staged = () => {};
    const confirmRestart = vi.fn(async () => true);
    const updater = new Updater({
      version: '0.1.1',
      source,
      ...quiet,
      confirmRestart,
      staged: (fn) => (staged = fn),
    });
    source.next = 'available';
    await updater.update();
    source.emit('update-downloaded', { version: '0.2.0' });
    expect(updater.current()).toMatchObject({ state: 'downloading', available: '0.2.0', percent: 100 });
    expect(confirmRestart).not.toHaveBeenCalled();
    staged();
    expect(updater.current()).toMatchObject({ state: 'ready', available: '0.2.0' });
    await vi.waitFor(() => expect(source.installs).toBe(1));
  });

  it('names the version a failed download was for, and keeps a staged update', async () => {
    const { updater, source } = setup();
    source.next = 'available';
    await updater.check();
    source.emit('error', new Error('code signature invalid'));
    expect(updater.current()).toMatchObject({ state: 'error', available: '0.2.0', error: 'code signature invalid' });

    source.next = 'none';
    await updater.check();
    expect(updater.current().available).toBeUndefined();

    source.emit('update-downloaded', { version: '0.3.0' });
    source.emit('error', new Error('late'));
    expect(updater.current()).toMatchObject({ state: 'ready', available: '0.3.0' });
  });

  it('does not schedule without a source', () => {
    const setTimer = vi.fn();
    new Updater({ version: '0.1.1', ...quiet, setTimer }).schedule();
    expect(setTimer).not.toHaveBeenCalled();
  });
});
