import { mkdirSync, mkdtempSync, readlinkSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cliLinkPath, installCli, repairCli } from './cli-install';

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

  it('refuses a source macOS runs from a translocated copy', () => {
    const home = setup().home;
    const dir = join(mkdtempSync(join(tmpdir(), 'x-')), 'AppTranslocation/ABC/d/Agent Brief.app/Contents/Resources/bin');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'agent-brief'), '');
    expect(() => installCli({ source: join(dir, 'agent-brief'), home, pathEnv: '' })).toThrow(/Applications folder/);
  });

  it('fails clearly when the CLI was not built', () => {
    expect(() => installCli({ source: '/nope/agent-brief.mjs', home: setup().home, pathEnv: '' })).toThrow(/Run pnpm build\./);
  });
});

describe('repairCli', () => {
  function bundled() {
    const bin = join(mkdtempSync(join(tmpdir(), 'apps-')), 'Agent Brief.app/Contents/Resources/bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'agent-brief'), '#!/bin/sh\n');
    return join(bin, 'agent-brief');
  }

  it('re-points a link whose app is gone', () => {
    const home = setup().home;
    const old = bundled();
    const source = bundled();
    installCli({ source: old, home, pathEnv: '' });
    rmSync(old);
    expect(repairCli({ source, home })).toBe(true);
    expect(readlinkSync(cliLinkPath(home))).toBe(source);
  });

  it('leaves a missing link, a live copy and a foreign link alone', () => {
    const home = setup().home;
    const source = bundled();
    expect(repairCli({ source, home })).toBe(false);

    const live = bundled();
    installCli({ source: live, home, pathEnv: '' });
    expect(repairCli({ source, home })).toBe(false);
    expect(readlinkSync(cliLinkPath(home))).toBe(live);

    unlinkSync(cliLinkPath(home));
    symlinkSync('/gone/some-other-tool', cliLinkPath(home));
    expect(repairCli({ source, home })).toBe(false);
  });
});
