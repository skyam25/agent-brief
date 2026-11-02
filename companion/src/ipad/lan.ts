/** This Mac's local network: its names, its private addresses, and which peers count as local. */

import { execFileSync } from 'node:child_process';
import { hostname, type NetworkInterfaceInfo } from 'node:os';

export type Interfaces = Record<string, NetworkInterfaceInfo[] | undefined>;

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

/** Whether an IPv4 address is in 10/8, 172.16/12 or 192.168/16. */
export function isPrivateIpv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n === undefined) return false;
  const a = n >>> 24;
  const b = (n >>> 16) & 255;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** `::ffff:a.b.c.d` becomes `a.b.c.d`. Other addresses pass through. */
export function stripMapped(address: string): string {
  const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  return m ? m[1] : address;
}

function isLoopback(address: string): boolean {
  const ip = stripMapped(address);
  return ip === '::1' || (ipv4ToInt(ip) !== undefined && ip.startsWith('127.'));
}

/** Tunnels hold private addresses too, but they do not lead to this room's network. */
const TUNNEL = /^(utun|awdl|llw|ppp|ipsec|gif|stf)/;

function privateInterfaces(interfaces: Interfaces): { name: string; address: string; netmask: string }[] {
  return Object.entries(interfaces)
    .flatMap(([name, infos]) => (TUNNEL.test(name) ? [] : (infos ?? []).map((info) => ({ ...info, name }))))
    .filter((i) => (i.family === 'IPv4' || (i.family as unknown) === 4) && !i.internal && isPrivateIpv4(i.address))
    .sort((a, b) => Number(b.name.startsWith('en')) - Number(a.name.startsWith('en')));
}

/** Private IPv4 addresses, Wi-Fi and Ethernet first. */
export function lanAddresses(interfaces: Interfaces): string[] {
  return privateInterfaces(interfaces).map((i) => i.address);
}

/** Whether a connection's address is on this Mac or on one of its private subnets. */
export function isLocalPeer(remote: string | undefined, interfaces: Interfaces): boolean {
  if (!remote) return false;
  if (isLoopback(remote)) return true;
  const ip = ipv4ToInt(stripMapped(remote));
  if (ip === undefined) return false;
  return privateInterfaces(interfaces).some((i) => {
    const own = ipv4ToInt(i.address);
    const mask = ipv4ToInt(i.netmask);
    return own !== undefined && mask !== undefined && ((ip & mask) >>> 0) === ((own & mask) >>> 0);
  });
}

/** `192.168.1.x` for a /24 network, otherwise the bare address. */
export function networkLabel(address: string, interfaces: Interfaces): string {
  const info = privateInterfaces(interfaces).find((i) => i.address === address);
  return info?.netmask === '255.255.255.0' ? address.replace(/\.\d+$/, '.x') : address;
}

function scutil(key: string): string | undefined {
  try {
    return execFileSync('/usr/sbin/scutil', ['--get', key], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** The name the iPad shows, and the `.local` name mDNS answers for. */
export function macNames(): { computer: string; local?: string } {
  const local = scutil('LocalHostName');
  return { computer: scutil('ComputerName') ?? hostname(), ...(local ? { local: `${local}.local` } : {}) };
}
