import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { UpdateStatus } from '../shared/ipc';
import { CHECK_EVERY_MS, FIRST_CHECK_MS, Updater, type UpdateSource } from './updater';

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

  it('checks soon after launch, then on an interval', () => {
    const source = new FakeSource();
    const timers: { fn: () => void; ms: number }[] = [];
    const updater = new Updater({
      version: '0.1.1',
      source,
      ...quiet,
      setTimer: (fn, ms) => (timers.push({ fn, ms }), {}),
    });
    updater.schedule();
    expect(timers.map((t) => t.ms)).toEqual([FIRST_CHECK_MS]);
    timers[0].fn();
    expect(source.checks).toBe(1);
    expect(timers.map((t) => t.ms)).toEqual([FIRST_CHECK_MS, CHECK_EVERY_MS]);
  });

  it('does not schedule without a source', () => {
    const setTimer = vi.fn();
    new Updater({ version: '0.1.1', ...quiet, setTimer }).schedule();
    expect(setTimer).not.toHaveBeenCalled();
  });
});
