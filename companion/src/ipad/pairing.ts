/** The one-use pairing code and the list of paired iPads. A paired iPad stays paired until forgotten on the Mac. */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { IpadDevice } from '../protocol';

export const CODE_TTL_MS = 10 * 60_000;
const FILE_VERSION = 1;

/** Writes of `lastSeen` are spaced out to spare the disk. */
const LAST_SEEN_WRITE_MS = 60_000;
const MAX_NAME = 80;

interface StoredDevice extends IpadDevice {
  firstSeen: number;
  secretHash: string;
  installId?: string;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest();

function cleanDeviceName(raw: string): string {
  const name = raw.replace(/\p{C}+/gu, ' ').trim().slice(0, MAX_NAME);
  return name || 'iPad';
}

const publicInfo = (d: StoredDevice): IpadDevice => ({ id: d.id, name: d.name, lastSeen: d.lastSeen, pairedAt: d.firstSeen });

export class PairingStore {
  private code?: { hash: Buffer; expires: number };
  private readonly devices = new Map<string, StoredDevice>();
  private readonly listeners = new Set<() => void>();
  private readonly now: () => number;

  constructor(private readonly opts: { devicesFile: string; now?: () => number }) {
    this.now = opts.now ?? Date.now;
    try {
      const data = JSON.parse(readFileSync(opts.devicesFile, 'utf8')) as { version?: unknown; devices?: unknown };
      if (data?.version === FILE_VERSION && Array.isArray(data.devices)) {
        for (const d of data.devices as StoredDevice[]) {
          if (typeof d?.id === 'string' && typeof d.secretHash === 'string' && typeof d.name === 'string') this.devices.set(d.id, d);
        }
      }
    } catch {
      // A missing or unreadable file starts an empty list.
    }
  }

  /** Makes a fresh code, good for 10 minutes and one use. It cancels the previous code. */
  newCode(): string {
    const code = randomBytes(32).toString('base64url');
    this.code = { hash: sha256(code), expires: this.now() + CODE_TTL_MS };
    return code;
  }

  cancelCode(): void {
    this.code = undefined;
  }

  /**
   * Trades the code for a device and its credential, `<id>.<secret>`. A wrong code leaves the live one standing.
   * The same `installId` replaces that iPad's old entry. A name another iPad holds gets a number.
   */
  redeem(code: string, deviceName: string, installId?: string): { credential: string; device: IpadDevice } | undefined {
    const live = this.code;
    if (!live || live.expires <= this.now() || !timingSafeEqual(live.hash, sha256(code))) return undefined;
    this.code = undefined;
    const id = randomBytes(9).toString('base64url');
    const secret = randomBytes(32).toString('base64url');
    const t = this.now();
    if (installId) {
      for (const d of this.devices.values()) if (d.installId === installId) this.devices.delete(d.id);
    }
    const device: StoredDevice = {
      id,
      name: this.freeName(cleanDeviceName(deviceName)),
      firstSeen: t,
      lastSeen: t,
      secretHash: sha256(secret).toString('hex'),
      ...(installId ? { installId } : {}),
    };
    this.devices.set(id, device);
    this.save();
    this.emit();
    return { credential: `${id}.${secret}`, device: publicInfo(device) };
  }

  /** The device a credential belongs to. A match counts as a use. */
  verify(credential: string | undefined): IpadDevice | undefined {
    if (!credential) return undefined;
    const dot = credential.indexOf('.');
    if (dot < 1) return undefined;
    const device = this.devices.get(credential.slice(0, dot));
    if (!device) return undefined;
    const stored = Buffer.from(device.secretHash, 'hex');
    const given = sha256(credential.slice(dot + 1));
    if (stored.length !== given.length || !timingSafeEqual(stored, given)) return undefined;
    const t = this.now();
    if (t - device.lastSeen >= LAST_SEEN_WRITE_MS) {
      device.lastSeen = t;
      this.save();
      this.emit();
    }
    return publicInfo(device);
  }

  list(): IpadDevice[] {
    return [...this.devices.values()].map(publicInfo);
  }

  get paired(): boolean {
    return this.devices.size > 0;
  }

  revoke(id: string): boolean {
    if (!this.devices.delete(id)) return false;
    this.save();
    this.emit();
    return true;
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private freeName(name: string): string {
    const taken = new Set([...this.devices.values()].map((d) => d.name));
    if (!taken.has(name)) return name;
    let n = 2;
    while (taken.has(`${name} ${n}`)) n += 1;
    return `${name} ${n}`;
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  private save(): void {
    const tmp = `${this.opts.devicesFile}.tmp`;
    mkdirSync(dirname(this.opts.devicesFile), { recursive: true });
    writeFileSync(tmp, JSON.stringify({ version: FILE_VERSION, devices: [...this.devices.values()] }, null, 2), { mode: 0o600 });
    renameSync(tmp, this.opts.devicesFile);
  }
}
