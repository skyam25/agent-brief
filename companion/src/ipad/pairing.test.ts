import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CODE_TTL_MS, PairingStore } from './pairing';

function store(now = () => 1000) {
  return new PairingStore({ devicesFile: join(mkdtempSync(join(tmpdir(), 'pair-')), 'devices.json'), now });
}

describe('PairingStore', () => {
  it('trades a code once for a working credential', () => {
    const s = store();
    const code = s.newCode();
    const paired = s.redeem(code, "Simon's iPad")!;
    expect(paired.device.name).toBe("Simon's iPad");
    expect(s.verify(paired.credential)?.id).toBe(paired.device.id);
    expect(s.redeem(code, 'again')).toBeUndefined();
    expect(s.list()).toHaveLength(1);
  });

  it('cancels the previous code when it makes a new one', () => {
    const s = store();
    const old = s.newCode();
    const fresh = s.newCode();
    expect(s.redeem(old, 'x')).toBeUndefined();
    expect(s.redeem(fresh, 'x')).toBeDefined();
  });

  it('keeps the live code after a wrong guess', () => {
    const s = store();
    const code = s.newCode();
    expect(s.redeem('wrong', 'x')).toBeUndefined();
    expect(s.redeem(code, 'x')).toBeDefined();
  });

  it('refuses an expired code', () => {
    let t = 0;
    const s = store(() => t);
    const code = s.newCode();
    t = CODE_TTL_MS;
    expect(s.redeem(code, 'x')).toBeUndefined();
  });

  it('refuses bad credentials', () => {
    const s = store();
    const { credential, device } = s.redeem(s.newCode(), 'x')!;
    expect(s.verify(undefined)).toBeUndefined();
    expect(s.verify('nodot')).toBeUndefined();
    expect(s.verify(`${device.id}.wrong`)).toBeUndefined();
    expect(s.verify(`other.${credential.split('.')[1]}`)).toBeUndefined();
  });

  it('keeps a device across restarts, hashed and private, however long it sits idle', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pair-'));
    const devicesFile = join(dir, 'devices.json');
    const first = new PairingStore({ devicesFile, now: () => 0 });
    const { credential } = first.redeem(first.newCode(), 'x')!;
    const secret = credential.split('.')[1];
    expect(readFileSync(devicesFile, 'utf8')).not.toContain(secret);
    expect(statSync(devicesFile).mode & 0o777).toBe(0o600);
    const later = new PairingStore({ devicesFile, now: () => 365 * 24 * 3600_000 });
    expect(later.verify(credential)).toBeDefined();
  });

  it('forgets a device', () => {
    const s = store();
    const { credential, device } = s.redeem(s.newCode(), 'x')!;
    expect(s.revoke(device.id)).toBe(true);
    expect(s.verify(credential)).toBeUndefined();
    expect(s.paired).toBe(false);
  });

  it('cleans the device name', () => {
    const s = store();
    expect(s.redeem(s.newCode(), ' a\u0007b ')!.device.name).toBe('a b');
    expect(s.redeem(s.newCode(), '   ')!.device.name).toBe('iPad');
  });

  it('keeps several iPads apart and numbers a repeated name', () => {
    const s = new PairingStore({ devicesFile: join(mkdtempSync(join(tmpdir(), 'pair-')), 'devices.json') });
    const a = s.redeem(s.newCode(), 'iPad', 'install-a')!;
    const b = s.redeem(s.newCode(), 'iPad', 'install-b')!;
    expect(s.list().map((d) => d.name)).toEqual(['iPad', 'iPad 2']);
    expect(s.verify(a.credential)?.id).toBe(a.device.id);
    expect(s.verify(b.credential)?.id).toBe(b.device.id);
    s.revoke(a.device.id);
    expect(s.verify(a.credential)).toBeUndefined();
    expect(s.verify(b.credential)?.id).toBe(b.device.id);
  });

  it('replaces the entry when the same iPad pairs again', () => {
    const s = new PairingStore({ devicesFile: join(mkdtempSync(join(tmpdir(), 'pair-')), 'devices.json') });
    const old = s.redeem(s.newCode(), 'iPad', 'same')!;
    const fresh = s.redeem(s.newCode(), 'iPad', 'same')!;
    expect(s.list().map((d) => d.id)).toEqual([fresh.device.id]);
    expect(s.list()[0].name).toBe('iPad');
    expect(s.verify(old.credential)).toBeUndefined();
  });
});
