import { describe, expect, it } from 'vitest';
import { IPAD_PEER_SERVICE, pairUrl, parsePairUrl, peerInstanceName, type PairLink } from './ipad';

const link: PairLink = {
  hosts: ['simons-mac.local', '192.168.1.20'],
  port: 47613,
  code: 'abc_-1',
  fingerprint: 'f1ng3r_-',
  mac: "Simon's Mac",
};

describe('pair links', () => {
  it('round-trips through the QR url', () => {
    expect(parsePairUrl(pairUrl(link))).toEqual(link);
  });

  it.each([
    'https://example.com/pair?h=a&p=1&c=c&f=f',
    'agentbrief://other?h=a&p=1&c=c&f=f',
    'agentbrief://pair?p=1&c=c&f=f',
    'agentbrief://pair?h=a&p=99999&c=c&f=f',
    'agentbrief://pair?h=a&p=1&f=f',
    'not a url',
  ])('rejects %s', (url) => {
    expect(parsePairUrl(url)).toBeUndefined();
  });
});

describe('peer service', () => {
  it('names the instance after the first 16 characters of the fingerprint', () => {
    expect(IPAD_PEER_SERVICE).toBe('_agentbrief._tcp');
    expect(peerInstanceName('Ab_-0123456789xyTAIL-ignored')).toBe('ab-Ab_-0123456789xy');
    expect(peerInstanceName('Ab_-0123456789xyTAIL-ignored')).toHaveLength(19);
  });
});
