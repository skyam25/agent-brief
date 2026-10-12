import { describe, expect, it } from 'vitest';
import { preferredLauncher } from './ResumeRow';

describe('preferredLauncher', () => {
  const all = ['ghostty', 'terminal', 'herdr', 'copy'] as const;

  it('picks the terminal the session ran in when this Mac has it', () => {
    expect(preferredLauncher({ host: { terminal: 'ghostty', herdrPane: 'w1:p1' } }, [...all])).toBe('herdr');
    expect(preferredLauncher({ host: { terminal: 'Apple_Terminal' } }, [...all])).toBe('terminal');
    expect(preferredLauncher({ host: { terminal: 'ghostty' } }, [...all])).toBe('ghostty');
    expect(preferredLauncher({ host: { terminal: 'tmux', bundleId: 'com.mitchellh.ghostty' } }, [...all])).toBe('ghostty');
  });

  it('falls back to the first terminal, then to Copy', () => {
    expect(preferredLauncher({ host: { terminal: 'ghostty' } }, ['terminal', 'copy'])).toBe('terminal');
    expect(preferredLauncher({}, ['herdr', 'copy'])).toBe('herdr');
    expect(preferredLauncher({ host: { terminal: 'iTerm.app' } }, ['copy'])).toBe('copy');
    expect(preferredLauncher({}, [])).toBeUndefined();
  });
});
