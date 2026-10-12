import { describe, expect, it } from 'vitest';
import { hostLabel, hueOf, modeLabel, sessionTitle, shortFolder, shortPath } from './sessions';

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

describe('modeLabel', () => {
  it('names the mode, with the fidelity only for prototype, and nothing for default', () => {
    expect(modeLabel('product')).toBe('Product');
    expect(modeLabel('orchestrate')).toBe('Orchestrate');
    expect(modeLabel('prototype')).toBe('Prototype');
    expect(modeLabel('prototype', 'freeze-patch')).toBe('Prototype · Freeze + patch');
    expect(modeLabel('prototype', 'styled')).toBe('Prototype · Styled HTML');
    expect(modeLabel('product', 'wireframe')).toBe('Product');
    expect(modeLabel('default')).toBeUndefined();
    expect(modeLabel(undefined)).toBeUndefined();
  });
});

describe('shortFolder', () => {
  it('keeps ~ and the last two folders', () => {
    expect(shortFolder('/Users/me/Projects/app', '/Users/me')).toBe('~/Projects/app');
    expect(shortFolder('/Users/me/app', '/Users/me')).toBe('~/app');
    expect(shortFolder('/Users/me/a/b/app', '/Users/me')).toBe('…/b/app');
    expect(shortFolder('/var/folders/xy/T/project-1')).toBe('…/T/project-1');
    expect(shortFolder('/opt/app')).toBe('/opt/app');
  });
});

describe('hueOf', () => {
  it('is stable per id and spreads ids apart', () => {
    expect(hueOf('s1')).toBe(hueOf('s1'));
    const hues = ['s1', 's2', 's3', 's4'].map(hueOf);
    expect(new Set(hues).size).toBe(4);
    // Neighbors differ by a golden angle, not a degree or two.
    expect(Math.abs(hueOf('s1') - hueOf('s2'))).toBeGreaterThan(60);
    expect(hueOf('x')).toBeGreaterThanOrEqual(0);
    expect(hueOf('x')).toBeLessThan(360);
  });
});
