import { describe, expect, it } from 'vitest';
import { hostLabel, sessionTitle, shortPath } from './sessions';

describe('session words', () => {
  it('names where a session runs, herdr first', () => {
    expect(hostLabel({ terminal: 'ghostty', herdrPane: 'w1:p1' })).toBe('herdr');
    expect(hostLabel({ terminal: 'Apple_Terminal' })).toBe('Terminal');
    expect(hostLabel({ terminal: 'kitty' })).toBe('kitty');
    expect(hostLabel(undefined)).toBeUndefined();
  });

  it('titles a session by project and host, and shortens home paths', () => {
    expect(sessionTitle({ sessionId: 's', cwd: '/Users/me/app', host: { terminal: 'ghostty' } })).toBe('app · Ghostty');
    expect(sessionTitle({ sessionId: 's', cwd: '/x', title: 'Login' })).toBe('Login');
    expect(shortPath('/Users/me/app', '/Users/me')).toBe('~/app');
    expect(shortPath('/opt/app', '/Users/me')).toBe('/opt/app');
  });
});
