import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * One temp folder per test run. Suites point TMPDIR at it, so every
 * mkdtemp, app profile and project folder lands inside and goes with it.
 *
 * Names stay short because macOS caps Unix socket paths at 104 bytes and
 * E2E sockets sit three folders down.
 */

const STALE_MS = 24 * 60 * 60 * 1000;

/** The system temp folder, read before any suite overrides TMPDIR. */
const systemTmp = tmpdir();

export function runDir(prefix: string, pid = process.pid): string {
  return join(systemTmp, `${prefix}-${pid}`);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Removes run folders whose runner has exited or that are over a day old. */
export function sweepStale(prefix: string): void {
  const pattern = new RegExp(`^${prefix}-(\\d+)$`);
  for (const name of readdirSync(systemTmp)) {
    const pid = Number(name.match(pattern)?.[1]);
    if (!pid || pid === process.pid) continue;
    const dir = join(systemTmp, name);
    const old = Date.now() - statSync(dir).mtimeMs > STALE_MS;
    if (old || !alive(pid)) rmSync(dir, { recursive: true, force: true });
  }
}

/** Sweeps stale runs and makes an empty folder for this one. */
export function startRun(prefix: string): string {
  sweepStale(prefix);
  const dir = runDir(prefix);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Deletes this run's folder unless KEEP_TEST_TMP=1. */
export function endRun(dir: string): void {
  if (process.env.KEEP_TEST_TMP === '1') {
    console.log(`Kept test temp folder: ${dir}`);
    return;
  }
  rmSync(dir, { recursive: true, force: true });
}
