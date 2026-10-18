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

function setup(source = new FakeSource()) {
  const seen: UpdateStatus[] = [];
  const order: string[] = [];
  const updater = new Updater({
    version: '0.1.1',
    source,
    onStatus: (s) => seen.push(s),
    beforeInstall: async () => void order.push('flush'),
    now: () => 1000,
  });
  const install = source.quitAndInstall.bind(source);
  source.quitAndInstall = () => {
    order.push('install');
    install();
  };
  return { updater, source, seen, order };
}

describe('Updater', () => {
  it('is off without a source and never checks', async () => {
    const updater = new Updater({ version: '0.1.1', onStatus: () => {}, beforeInstall: async () => {} });
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

  it('updates in one step when the user asks: check, download, restart', async () => {
    const { updater, source, order } = setup();
    source.next = 'available';
    expect(await updater.update()).toMatchObject({ state: 'downloading', restart: true });
    expect(source.installs).toBe(0);
    source.emit('update-downloaded', { version: '0.2.0' });
    await vi.waitFor(() => expect(order).toEqual(['flush', 'install']));
  });

  it('restarts after a background download the user asks for', async () => {
    const { updater, source } = setup();
    source.next = 'available';
    await updater.check();
    expect(updater.current().restart).toBeUndefined();
    await updater.update();
    expect(source.checks).toBe(1);
    source.emit('update-downloaded', { version: '0.2.0' });
    await vi.waitFor(() => expect(source.installs).toBe(1));
  });

  it('installs a ready update at once', async () => {
    const { updater, source } = setup();
    source.emit('update-downloaded', { version: '0.2.0' });
    await updater.update();
    expect(source.checks).toBe(0);
    expect(source.installs).toBe(1);
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
      onStatus: () => {},
      beforeInstall: async () => {},
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
    new Updater({ version: '0.1.1', onStatus: () => {}, beforeInstall: async () => {}, setTimer }).schedule();
    expect(setTimer).not.toHaveBeenCalled();
  });
});
