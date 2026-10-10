import { describe, expect, it } from 'vitest';
import {
  appleQuote,
  focusSession,
  ghosttyFocusScript,
  ghosttyScript,
  shellQuote,
  startCommand,
  startSession,
  terminalScript,
} from './launch';

const recorder = (answer = '') => {
  const calls: string[][] = [];
  const run = async (file: string, args: string[]) => {
    calls.push([file, ...args]);
    return answer;
  };
  return { calls, run };
};

describe('quoting', () => {
  it('survives quotes and spaces in paths', () => {
    expect(shellQuote("it's here")).toBe(`'it'\\''s here'`);
    expect(appleQuote('a "b" \\ c')).toBe('"a \\"b\\" \\\\ c"');
    expect(startCommand('/p/my app', "/p/my app/it's.md")).toBe(`cd '/p/my app' && claude "$(cat '/p/my app/it'\\''s.md')"`);
  });

  it('builds AppleScript that opens the folder and types the command', () => {
    const g = ghosttyScript('/p/app', '/p/app/prompt.md');
    expect(g).toContain('set initial working directory of cfg to "/p/app"');
    expect(g).toContain(`set initial input of cfg to "claude \\"$(cat '/p/app/prompt.md')\\"\n"`);
    expect(terminalScript('/p/app', '/p/app/prompt.md')).toContain(
      `do script "cd '/p/app' && claude \\"$(cat '/p/app/prompt.md')\\""`,
    );
  });
});

describe('startSession', () => {
  it('opens a herdr tab in the folder and runs Claude Code in its pane', async () => {
    const { calls, run } = recorder(JSON.stringify({ result: { root_pane: { pane_id: 'w2:p5' } } }));
    await startSession(run, 'herdr', '/p/app', '/p/app/prompt.md', '/bin/herdr');
    expect(calls).toEqual([
      ['/bin/herdr', 'tab', 'create', '--cwd', '/p/app', '--label', 'sketch', '--focus'],
      ['/bin/herdr', 'pane', 'run', 'w2:p5', `claude "$(cat '/p/app/prompt.md')"`],
    ]);
  });

  it('says so when herdr is missing', async () => {
    await expect(startSession(recorder().run, 'herdr', '/p', '/p/x.md')).rejects.toThrow(/herdr is not installed/);
  });
});

describe('focusSession', () => {
  it('focuses a herdr pane, then the Ghostty terminal it captured', async () => {
    const { calls, run } = recorder();
    const host = { herdrPane: 'w1:p2', terminal: 'ghostty', bundleId: 'com.mitchellh.ghostty' };
    await focusSession(run, { cwd: '/p/app', host }, { herdr: '/bin/herdr', ghosttyTerminal: 'T-1' });
    expect(calls[0]).toEqual(['/bin/herdr', 'agent', 'focus', 'w1:p2']);
    expect(calls[1]).toEqual(['osascript', '-e', ghosttyFocusScript('/p/app', 'T-1')]);
    expect(calls[1][2]).toContain('whose id is "T-1"');
  });

  it('brings any other app forward by its bundle id, and does nothing without a host', async () => {
    const { calls, run } = recorder();
    expect(await focusSession(run, { cwd: '/p', host: { terminal: 'iTerm.app', bundleId: 'com.googlecode.iterm2' } })).toBe(true);
    expect(calls).toEqual([['open', '-b', 'com.googlecode.iterm2']]);
    expect(await focusSession(run, { cwd: '/p' })).toBe(false);
  });
});
