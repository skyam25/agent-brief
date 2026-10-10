/** One-time pairing tokens and the list of paired devices. */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const COOKIE_NAME = 'companion_device';
export const TOKEN_TTL_MS = 10 * 60_000;
const COOKIE_MAX_AGE_S = 365 * 24 * 3600;
/** Writes of `lastSeen` are spaced out to spare the disk. */
const LAST_SEEN_WRITE_MS = 60_000;

export interface DeviceInfo {
  id: string;
  name: string;
  firstSeen: number;
  lastSeen: number;
}

interface StoredDevice extends DeviceInfo {
  secretHash: string;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && timingSafeEqual(x, y);
}

/** A short device label from a User-Agent string. */
export function deviceName(userAgent: string | undefined): string {
  const ua = userAgent ?? '';
  const device = /iPad/.test(ua)
    ? 'iPad'
    : /iPhone/.test(ua)
      ? 'iPhone'
      : /Android/.test(ua)
        ? 'Android'
        : /Macintosh/.test(ua)
          ? 'Mac'
          : /Windows/.test(ua)
            ? 'Windows'
            : /Linux/.test(ua)
              ? 'Linux'
              : 'Unknown device';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Firefox\//.test(ua)
      ? 'Firefox'
      : /Chrome\/|CriOS\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : undefined;
  return browser ? `${device} (${browser})` : device;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export interface PairingOptions {
  devicesFile: string;
  now?: () => number;
}

export class PairingStore {
  private tokens = new Map<string, number>();
  private devices = new Map<string, StoredDevice>();
  private listeners = new Set<() => void>();
  private now: () => number;

  constructor(private opts: PairingOptions) {
    this.now = opts.now ?? Date.now;
    try {
      const data: unknown = JSON.parse(readFileSync(opts.devicesFile, 'utf8'));
      if (Array.isArray(data)) {
        for (const d of data as StoredDevice[]) {
          if (typeof d?.id === 'string' && typeof d.secretHash === 'string') this.devices.set(d.id, d);
        }
      }
    } catch {
      // A missing or unreadable file starts an empty list.
    }
  }

  /** A fresh token, good for 10 minutes and one use. */
  newToken(): string {
    const token = randomBytes(32).toString('base64url');
    this.tokens.set(sha256(token), this.now() + TOKEN_TTL_MS);
    return token;
  }

  /** Trades a token for a device. The token is spent whether or not it was still valid. */
  redeem(token: string, userAgent: string | undefined): { cookie: string; device: DeviceInfo } | undefined {
    const key = sha256(token);
    const expires = this.tokens.get(key);
    this.tokens.delete(key);
    for (const [k, exp] of this.tokens) if (exp <= this.now()) this.tokens.delete(k);
    if (expires === undefined || expires <= this.now()) return undefined;

    const id = randomBytes(9).toString('base64url');
    const secret = randomBytes(32).toString('base64url');
    const t = this.now();
    const device: StoredDevice = {
      id,
      name: deviceName(userAgent),
      firstSeen: t,
      lastSeen: t,
      secretHash: sha256(secret),
    };
    this.devices.set(id, device);
    this.save();
    this.emit();
    const cookie = `${COOKIE_NAME}=${id}.${secret}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE_S}`;
    return { cookie, device: publicInfo(device) };
  }

  /** The device a Cookie header belongs to, if its secret matches. */
  verify(cookieHeader: string | undefined): DeviceInfo | undefined {
    const value = parseCookies(cookieHeader)[COOKIE_NAME];
    if (!value) return undefined;
    const dot = value.indexOf('.');
    if (dot < 1) return undefined;
    const device = this.devices.get(value.slice(0, dot));
    if (!device || !safeEqualHex(device.secretHash, sha256(value.slice(dot + 1)))) return undefined;
    const t = this.now();
    if (t - device.lastSeen >= LAST_SEEN_WRITE_MS) {
      device.lastSeen = t;
      this.save();
      this.emit();
    }
    return publicInfo(device);
  }

  list(): DeviceInfo[] {
    return [...this.devices.values()].map(publicInfo);
  }

  has(id: string): boolean {
    return this.devices.has(id);
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

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  private save(): void {
    const tmp = `${this.opts.devicesFile}.tmp`;
    mkdirSync(dirname(this.opts.devicesFile), { recursive: true });
    writeFileSync(tmp, JSON.stringify([...this.devices.values()], null, 2), { mode: 0o600 });
    renameSync(tmp, this.opts.devicesFile);
  }
}

function publicInfo(d: StoredDevice): DeviceInfo {
  return { id: d.id, name: d.name, firstSeen: d.firstSeen, lastSeen: d.lastSeen };
}
