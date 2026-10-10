import type { NetworkInterfaceInfo } from 'node:os';
import { describe, expect, it } from 'vitest';
import { isPrivateIpv4, isSameSubnet, pickLanInterface } from './lan';

const v4 = (address: string, netmask = '255.255.255.0', internal = false): NetworkInterfaceInfo => ({
  address,
  netmask,
  family: 'IPv4',
  mac: '00:00:00:00:00:00',
  internal,
  cidr: null,
});

describe('pickLanInterface', () => {
  it('skips loopback, public and IPv6, and returns the first private IPv4', () => {
    const picked = pickLanInterface({
      lo0: [v4('127.0.0.1', '255.0.0.0', true)],
      utun: [{ ...v4('fe80::1'), family: 'IPv6' } as NetworkInterfaceInfo],
      en1: [v4('8.8.8.8')],
      en0: [v4('192.168.1.23'), v4('10.0.0.5', '255.0.0.0')],
    });
    expect(picked).toEqual({ address: '192.168.1.23', netmask: '255.255.255.0', cidr: '192.168.1.0/24' });
  });

  it('computes the network for non-/24 masks', () => {
    expect(pickLanInterface({ en0: [v4('172.20.9.77', '255.255.240.0')] })?.cidr).toBe('172.20.0.0/20');
  });

  it('returns undefined with no candidate', () => {
    expect(pickLanInterface({ lo0: [v4('127.0.0.1', '255.0.0.0', true)] })).toBeUndefined();
    expect(pickLanInterface({})).toBeUndefined();
  });
});

describe('isPrivateIpv4', () => {
  it('knows the three ranges', () => {
    for (const ip of ['10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.0.1']) {
      expect(isPrivateIpv4(ip), ip).toBe(true);
    }
    for (const ip of ['172.15.0.1', '172.32.0.1', '192.169.0.1', '11.0.0.1', '8.8.8.8', 'nope']) {
      expect(isPrivateIpv4(ip), ip).toBe(false);
    }
  });
});

describe('isSameSubnet', () => {
  const iface = { address: '192.168.1.23', netmask: '255.255.255.0' };

  it('accepts addresses on the subnet', () => {
    expect(isSameSubnet('192.168.1.99', iface)).toBe(true);
    expect(isSameSubnet('192.168.1.1', iface)).toBe(true);
  });

  it('rejects addresses off the subnet', () => {
    expect(isSameSubnet('192.168.2.99', iface)).toBe(false);
    expect(isSameSubnet('10.0.0.1', iface)).toBe(false);
    expect(isSameSubnet('8.8.8.8', iface)).toBe(false);
    expect(isSameSubnet('2001:db8::1', iface)).toBe(false);
    expect(isSameSubnet(undefined, iface)).toBe(false);
    expect(isSameSubnet('', iface)).toBe(false);
  });

  it('handles IPv4-mapped IPv6', () => {
    expect(isSameSubnet('::ffff:192.168.1.50', iface)).toBe(true);
    expect(isSameSubnet('::ffff:192.168.9.50', iface)).toBe(false);
  });

  it('allows loopback', () => {
    expect(isSameSubnet('127.0.0.1', iface)).toBe(true);
    expect(isSameSubnet('::1', iface)).toBe(true);
    expect(isSameSubnet('::ffff:127.0.0.1', iface)).toBe(true);
  });

  it('honours wider masks', () => {
    expect(isSameSubnet('10.9.9.9', { address: '10.0.0.5', netmask: '255.0.0.0' })).toBe(true);
  });
});
