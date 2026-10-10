import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { IpadStatus } from '../shared/ipc';
import { SyncHub } from '../web/sync-hub';
import { Ipad, NO_LAN } from './ipad';

function make(over: Partial<ConstructorParameters<typeof Ipad>[0]> = {}) {
  let intro = false;
  const statuses: IpadStatus[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'ipad-'));
  const ipad = new Ipad({
    hub: new SyncHub(),
    staticDir: dir,
    devicesFile: join(dir, 'devices.json'),
    deliver: vi.fn(),
    currentBoard: () => 'scratch',
    describeSession: (id) => id,
    introShown: () => intro,
    markIntroShown: () => {
      intro = true;
    },
    onStatus: (s) => statuses.push(s),
    ...over,
  });
  return { ipad, statuses };
}

describe('Ipad', () => {
  it('starts nothing and says why when there is no private network', async () => {
    const { ipad } = make({ interfaces: () => ({ lo0: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', mac: '', internal: true, cidr: null }] }) as never });
    const s = await ipad.open();
    expect(s).toMatchObject({ running: false, error: NO_LAN });
    expect(s.url).toBeUndefined();
  });

  it('serves on the given address, makes a fresh one-time link each time, and stops', async () => {
    const { ipad, statuses } = make({ host: '127.0.0.1', port: 0 });
    const first = await ipad.open();
    expect(first).toMatchObject({ running: true, host: '127.0.0.1', firstRun: true, devices: [] });
    expect(first.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/pair\?token=/);
    expect(first.qrSvg).toContain('<svg');
    const second = await ipad.open();
    expect(second.firstRun).toBe(false);
    expect(second.url).not.toBe(first.url);
    const port = second.port!;
    const stopped = await ipad.stop();
    expect(stopped).toMatchObject({ running: false, url: undefined });
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
    expect(statuses.at(-1)?.running).toBe(false);
  });

  it('refuses a public address', async () => {
    const { ipad } = make({ host: '8.8.8.8', port: 0 });
    const s = await ipad.open();
    expect(s.running).toBe(false);
    expect(s.error).toMatch(/refusing to bind 8\.8\.8\.8/);
  });
});
