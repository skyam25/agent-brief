import type { NetworkInterfaceInfo } from 'node:os';
import { describe, expect, it } from 'vitest';
import { isLocalPeer, lanAddresses, networkLabel, type Interfaces } from './lan';

const v4 = (address: string, netmask = '255.255.255.0', internal = false) => ({ address, netmask, family: 'IPv4', internal }) as NetworkInterfaceInfo;

const interfaces: Interfaces = {
  lo0: [v4('127.0.0.1', '255.0.0.0', true)],
  bridge0: [v4('192.168.2.1')],
  en0: [v4('192.168.1.20')],
  utun4: [v4('10.8.0.2')],
  en7: [v4('8.8.4.4')],
};

describe('LAN helpers', () => {
  it('lists private addresses, Wi-Fi and Ethernet first, without tunnels', () => {
    expect(lanAddresses(interfaces)).toEqual(['192.168.1.20', '192.168.2.1']);
  });

  it.each([
    ['192.168.1.77', true],
    ['::ffff:192.168.1.77', true],
    ['192.168.2.9', true],
    ['127.0.0.1', true],
    ['::1', true],
    ['192.168.9.1', false],
    ['10.8.0.5', false],
    ['8.8.4.5', false],
    ['fe80::1', false],
    [undefined, false],
  ])('treats %s as local: %s', (remote, local) => {
    expect(isLocalPeer(remote, interfaces)).toBe(local);
  });

  it('names a /24 network by its prefix', () => {
    expect(networkLabel('192.168.1.20', interfaces)).toBe('192.168.1.x');
    expect(networkLabel('10.0.0.5', { en0: [v4('10.0.0.5', '255.0.0.0')] })).toBe('10.0.0.5');
  });
});
