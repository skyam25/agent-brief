import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Peer, type PeerOptions } from './peer';

const FAKE = join(__dirname, '../../e2e/fixtures/fake-peer.mjs');

let peers: Peer[] = [];
afterEach(async () => {
  for (const p of peers) await p.stop();
  peers = [];
  delete process.env.FAKE_PEER;
  delete process.env.FAKE_PEER_LOG;
});

/** A peer on the fake helper, scripted by `script`. `launches()` reads what each launch was given. */
function peer(script: object = {}, opts: Partial<PeerOptions> = {}) {
  const log = join(mkdtempSync(join(tmpdir(), 'peer-')), 'launches.jsonl');
  process.env.FAKE_PEER = JSON.stringify(script);
  process.env.FAKE_PEER_LOG = log;
  const changes: boolean[] = [];
  const p = new Peer({ argv: [process.execPath, FAKE], onChange: (up) => changes.push(up), ...opts });
  peers.push(p);
  const launches = (): { args: string[]; pid: number }[] =>
    existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  return { p, changes, launches };
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('Peer', () => {
  it('starts the helper with the name and port, and stops it', async () => {
    const { p, launches } = peer();
    expect(await p.start('ab-0123456789abcdef', 47613)).toEqual({ ok: true });
    expect(p.up).toBe(true);
    const [launch] = launches();
    expect(launch!.args).toEqual(['--name', 'ab-0123456789abcdef', '--port', '47613']);
    expect(alive(launch!.pid)).toBe(true);
    await p.stop();
    expect(p.up).toBe(false);
    expect(alive(launch!.pid)).toBe(false);
  });

  it('reports the reason the helper gives, without restarting', async () => {
    const { p, launches } = peer({ fail: 'Bonjour is off' }, { backoffMs: [10] });
    expect(await p.start('ab-x', 1)).toEqual({ ok: false, error: 'Bonjour is off' });
    await new Promise((r) => setTimeout(r, 100));
    expect(launches()).toHaveLength(1);
    expect(p.up).toBe(false);
  });

  it('reports a helper that cannot start', async () => {
    const p = new Peer({ argv: ['/nonexistent/agent-brief-peer'] });
    peers.push(p);
    const started = await p.start('ab-x', 1);
    expect(started.ok).toBe(false);
    expect(!started.ok && started.error).toMatch(/ENOENT/);
  });

  it('gives up on a helper that never reports ready, and ends it', async () => {
    const { p, launches } = peer({ silent: true }, { readyMs: 200 });
    expect(await p.start('ab-x', 1)).toEqual({ ok: false, error: 'no ready line in 200 ms' });
    await expect.poll(() => alive(launches()[0]!.pid)).toBe(false);
  });

  it('restarts a helper that dies, up to the cap', async () => {
    const { p, changes, launches } = peer({ crashAfter: 40 }, { backoffMs: [10, 10] });
    expect((await p.start('ab-x', 1)).ok).toBe(true);
    await expect.poll(() => launches().length).toBe(3);
    await expect.poll(() => changes).toEqual([false, true, false, true, false]);
    await new Promise((r) => setTimeout(r, 150));
    expect(launches()).toHaveLength(3);
    expect(p.up).toBe(false);
    expect(p.error).toBe('exit code 1');
  });

  it('starts the count over once a helper stays up', async () => {
    const { p, launches } = peer({ crashAfter: 60 }, { backoffMs: [10], stableMs: 30 });
    expect((await p.start('ab-x', 1)).ok).toBe(true);
    await expect.poll(() => launches().length).toBeGreaterThanOrEqual(3);
    await p.stop();
  });

  it('stays stopped when stopped during a restart wait', async () => {
    const { p, launches } = peer({ crashAfter: 20 }, { backoffMs: [200] });
    await p.start('ab-x', 1);
    await expect.poll(() => p.up).toBe(false);
    await p.stop();
    await new Promise((r) => setTimeout(r, 300));
    expect(launches()).toHaveLength(1);
  });
});
