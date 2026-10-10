/** LAN address helpers for the iPad web server. Same network only. */

import type { NetworkInterfaceInfo } from 'node:os';

export interface LanInterface {
  address: string;
  netmask: string;
  /** The network the address sits on, such as `192.168.1.0/24`. */
  cidr: string;
}

export function ipv4ToInt(ip: string): number | undefined {
  const parts = ip.split('.');
  if (parts.length !== 4) return undefined;
  let n = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part) || Number(part) > 255) return undefined;
    n = n * 256 + Number(part);
  }
  return n;
}

function intToIpv4(n: number): string {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

function prefixLength(netmask: string): number | undefined {
  const m = ipv4ToInt(netmask);
  if (m === undefined) return undefined;
  const bits = m.toString(2).padStart(32, '0');
  if (!/^1*0*$/.test(bits)) return undefined;
  const firstZero = bits.indexOf('0');
  return firstZero === -1 ? 32 : firstZero;
}

/** Whether an IPv4 address is in 10/8, 172.16/12 or 192.168/16. */
export function isPrivateIpv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n === undefined) return false;
  const a = n >>> 24;
  const b = (n >>> 16) & 255;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** Whether the address is on this machine (127/8 or ::1). */
export function isLoopback(address: string): boolean {
  const ip = stripMapped(address);
  return ip === '::1' || (ipv4ToInt(ip) !== undefined && ip.startsWith('127.'));
}

/** `::ffff:a.b.c.d` becomes `a.b.c.d`. Other addresses pass through. */
export function stripMapped(address: string): string {
  const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  return m ? m[1] : address;
}

type Interfaces = Record<string, NetworkInterfaceInfo[] | undefined>;

/** The first external IPv4 address in a private range. */
export function pickLanInterface(interfaces: Interfaces): LanInterface | undefined {
  for (const infos of Object.values(interfaces)) {
    for (const info of infos ?? []) {
      const isV4 = info.family === 'IPv4' || (info.family as unknown) === 4;
      if (!isV4 || info.internal || !isPrivateIpv4(info.address)) continue;
      const prefix = prefixLength(info.netmask);
      if (prefix === undefined) continue;
      const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
      const network = (ipv4ToInt(info.address)! & mask) >>> 0;
      return {
        address: info.address,
        netmask: info.netmask,
        cidr: `${intToIpv4(network)}/${prefix}`,
      };
    }
  }
  return undefined;
}

/**
 * Whether a remote address belongs to the interface's subnet. Accepts IPv4
 * and IPv4-mapped IPv6. Loopback always passes, for the Mac itself and tests.
 */
export function isSameSubnet(
  remote: string | undefined,
  iface: Pick<LanInterface, 'address' | 'netmask'>,
): boolean {
  if (!remote) return false;
  if (isLoopback(remote)) return true;
  const ip = ipv4ToInt(stripMapped(remote));
  const own = ipv4ToInt(iface.address);
  const mask = ipv4ToInt(iface.netmask);
  if (ip === undefined || own === undefined || mask === undefined) return false;
  return ((ip & mask) >>> 0) === ((own & mask) >>> 0);
}
