import { describe, expect, it } from 'vitest';
import { herdrNumbers, Terminals } from './terminals';

describe('herdrNumbers', () => {
  it('maps each workspace to its sidebar number', () => {
    const out = JSON.stringify({
      result: {
        type: 'workspace_list',
        workspaces: [
          { workspace_id: 'w1G', number: 16, label: 'agent-brief' },
          { workspace_id: 'w1M', number: 19, label: 'agent-brief' },
        ],
      },
    });
    expect([...herdrNumbers(out)]).toEqual([
      ['w1G', 16],
      ['w1M', 19],
    ]);
  });

  it('is empty for output it cannot read', () => {
    expect(herdrNumbers('').size).toBe(0);
    expect(herdrNumbers('{"result":{}}').size).toBe(0);
  });
});

describe('Terminals.notePrompts', () => {
  const ghostty = { terminal: 'ghostty', bundleId: 'com.mitchellh.ghostty' };
  const terminals = () => new Terminals({ testMode: true, writeClipboard: () => undefined });
  const asked = (t: Terminals) => t.launches.filter((l) => l.file === 'osascript').length;

  it('asks Ghostty for the front terminal once per fresh prompt', async () => {
    const t = terminals();
    await t.notePrompts([{ sessionId: 'a', cwd: '/w', host: ghostty, promptAt: 1000 }], 2000);
    await t.notePrompts([{ sessionId: 'a', cwd: '/w', host: ghostty, promptAt: 1000 }], 2500);
    expect(asked(t)).toBe(1);
    await t.notePrompts([{ sessionId: 'a', cwd: '/w', host: ghostty, promptAt: 3000 }], 3100);
    expect(asked(t)).toBe(2);
  });

  it('skips a stale prompt, a herdr pane and other terminals', async () => {
    const t = terminals();
    await t.notePrompts(
      [
        { sessionId: 'a', cwd: '/w', host: ghostty, promptAt: 1000 },
        { sessionId: 'b', cwd: '/w', host: { ...ghostty, herdrPane: 'w1:p1' }, promptAt: 60_000 },
        { sessionId: 'c', cwd: '/w', host: { terminal: 'Apple_Terminal' }, promptAt: 60_000 },
      ],
      60_000,
    );
    expect(asked(t)).toBe(0);
  });
});
