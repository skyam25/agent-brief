import { mkdtempSync, readlinkSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { installCli } from './cli-install';

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'home-'));
  const source = join(mkdtempSync(join(tmpdir(), 'app-')), 'agent-brief.mjs');
  writeFileSync(source, '#!/usr/bin/env node\n', { mode: 0o644 });
  return { home, source };
}

describe('installCli', () => {
  it('links into ~/.local/bin, makes the script executable and reports PATH', () => {
    const { home, source } = setup();
    const r = installCli({ source, home, pathEnv: '/usr/bin:/bin' });
    expect(r.link).toBe(join(home, '.local/bin/agent-brief'));
    expect(readlinkSync(r.link)).toBe(source);
    expect(r.onPath).toBe(false);
    expect(statSync(source).mode & 0o111).not.toBe(0);
    expect(installCli({ source, home, pathEnv: `/usr/bin:${home}/.local/bin/` }).onPath).toBe(true);
  });

  it('replaces an old link and refuses to replace a real file', () => {
    const { home, source } = setup();
    const other = setup().source;
    installCli({ source: other, home, pathEnv: '' });
    installCli({ source, home, pathEnv: '' });
    expect(readlinkSync(join(home, '.local/bin/agent-brief'))).toBe(source);

    const h2 = setup();
    installCli({ source: h2.source, home: h2.home, pathEnv: '' });
    const link = join(h2.home, '.local/bin/agent-brief');
    unlinkSync(link);
    writeFileSync(link, 'mine');
    expect(() => installCli({ source: h2.source, home: h2.home, pathEnv: '' })).toThrow(/not a link/);
  });

  it('fails clearly when the CLI was not built', () => {
    expect(() => installCli({ source: '/nope/agent-brief.mjs', home: setup().home, pathEnv: '' })).toThrow(/Run pnpm build\./);
  });
});
