import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FISH_FILE, POSIX_BLOCK, shellFiles, withBlock } from './herdr';
import { main } from './main';

describe('withBlock', () => {
  it('adds the block after a blank line and removes it back to the original', () => {
    const original = 'export PATH=/x:$PATH\n';
    const on = withBlock(original, true);
    expect(on).toBe(`${original}\n${POSIX_BLOCK}\n`);
    expect(withBlock(on, false)).toBe(original);
  });

  it('handles an empty file and a file without a final newline', () => {
    expect(withBlock('', true)).toBe(`${POSIX_BLOCK}\n`);
    expect(withBlock(withBlock('', true), false)).toBe('');
    expect(withBlock('alias g=git', true)).toBe(`alias g=git\n\n${POSIX_BLOCK}\n`);
  });

  it('keeps one block when added twice, and keeps lines after it on removal', () => {
    const twice = withBlock(withBlock('a\n', true), true);
    expect(twice.split(POSIX_BLOCK)).toHaveLength(2);
    expect(withBlock(`a\n\n${POSIX_BLOCK}\nb\n`, false)).toBe('a\nb\n');
  });

  it('sets the variable only inside Herdr', () => {
    expect(POSIX_BLOCK).toContain('if [ -n "$HERDR_ENV" ]; then export CLAUDE_CODE_FORCE_TERMINAL_IMAGES=1; fi');
    expect(FISH_FILE).toContain('if set -q HERDR_ENV; set -gx CLAUDE_CODE_FORCE_TERMINAL_IMAGES 1; end');
  });
});

describe('shellFiles', () => {
  const home = '/h';
  const has = (...paths: string[]) => (p: string) => paths.includes(p);

  it("picks the login shell's file even when missing, and other files that exist", () => {
    expect(shellFiles({ SHELL: '/bin/zsh' }, home, has('/h/.bashrc'))).toEqual([
      { path: '/h/.zshrc', kind: 'posix' },
      { path: '/h/.bashrc', kind: 'posix' },
    ]);
  });

  it('uses ZDOTDIR, XDG_CONFIG_HOME and a fish conf.d file', () => {
    expect(shellFiles({ SHELL: '/opt/bin/fish', ZDOTDIR: '/z', XDG_CONFIG_HOME: '/c' }, home, has('/z/.zshrc'))).toEqual([
      { path: '/z/.zshrc', kind: 'posix' },
      { path: '/c/fish/conf.d/agent-brief-herdr.fish', kind: 'fish' },
    ]);
  });

  it('creates .bash_profile for bash with no startup file, and falls back to .zshrc', () => {
    expect(shellFiles({ SHELL: '/bin/bash' }, home, has())).toEqual([{ path: '/h/.bash_profile', kind: 'posix' }]);
    expect(shellFiles({}, home, has())).toEqual([{ path: '/h/.zshrc', kind: 'posix' }]);
  });
});

describe('agent-brief herdr-pictures', () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-'));
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  async function run(argv: string[], env: Record<string, string> = { SHELL: '/bin/zsh' }) {
    let stdout = '';
    let stderr = '';
    const code = await main(['herdr-pictures', ...argv], {
      stdin: async () => '',
      stdout: (s) => (stdout += s),
      stderr: (s) => (stderr += s),
      env,
      home,
    });
    return { code, stdout, stderr };
  }

  const read = (f: string) => fs.readFileSync(path.join(home, f), 'utf8');

  it('turns on, reports already, shows status, and turns off', async () => {
    fs.writeFileSync(path.join(home, '.zshrc'), 'export A=1\n');
    fs.mkdirSync(path.join(home, '.config', 'fish'), { recursive: true });

    const on = await run(['on']);
    expect(on.code).toBe(0);
    expect(on.stdout).toContain('added to ~/.zshrc');
    expect(on.stdout).toContain('added to ~/.config/fish/conf.d/agent-brief-herdr.fish');
    expect(read('.zshrc')).toBe(`export A=1\n\n${POSIX_BLOCK}\n`);
    expect(read('.config/fish/conf.d/agent-brief-herdr.fish')).toBe(FISH_FILE);

    expect((await run(['on'])).stdout).toContain('already in ~/.zshrc');
    expect((await run([])).stdout).toContain('on   ~/.zshrc');

    const off = await run(['off']);
    expect(off.stdout).toContain('removed from ~/.zshrc');
    expect(read('.zshrc')).toBe('export A=1\n');
    expect(fs.existsSync(path.join(home, '.config/fish/conf.d/agent-brief-herdr.fish'))).toBe(false);
    expect((await run(['off'])).stdout).toContain('not in ~/.zshrc');
  });

  it("reports this shell's variable", async () => {
    const r = await run(['status'], { SHELL: '/bin/zsh', CLAUDE_CODE_FORCE_TERMINAL_IMAGES: '1' });
    expect(r.stdout).toContain('off  ~/.zshrc');
    expect(r.stdout).toContain('on   this shell');
  });

  it('rejects an unknown action', async () => {
    const r = await run(['maybe']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('on, off or status');
  });
});
