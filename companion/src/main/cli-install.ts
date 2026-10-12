/** Links the `agent-brief` CLI into `~/.local/bin`. */

import { chmodSync, existsSync, lstatSync, mkdirSync, readlinkSync, statSync, symlinkSync, unlinkSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';

export interface InstallResult {
  link: string;
  source: string;
  /** False when the folder is missing from PATH, so the user must add it. */
  onPath: boolean;
  binDir: string;
}

export function cliLinkPath(home: string): string {
  return join(home, '.local', 'bin', 'agent-brief');
}

/**
 * True when macOS runs the app from a randomized read-only copy, as it does for
 * a quarantined app the user has not moved yet. Links to that copy break.
 */
export function isTranslocated(path: string): boolean {
  return path.includes('/AppTranslocation/');
}

export const MOVE_APP_FIRST = 'Move Agent Brief to your Applications folder, open it from there, then try again.';

/** Creates or refreshes the link. Refuses to replace a real file that is not ours. */
export function installCli(opts: { source: string; home: string; pathEnv: string }): InstallResult {
  const { source, home } = opts;
  if (!existsSync(source)) throw new Error(`The CLI is missing at ${source}. Run pnpm build.`);
  if (isTranslocated(source)) throw new Error(MOVE_APP_FIRST);
  const binDir = join(home, '.local', 'bin');
  const link = cliLinkPath(home);
  mkdirSync(binDir, { recursive: true });

  let existing: ReturnType<typeof lstatSync> | undefined;
  try {
    existing = lstatSync(link);
  } catch {
    existing = undefined;
  }
  if (existing) {
    if (!existing.isSymbolicLink()) throw new Error(`${link} already exists and is not a link. Remove it first.`);
    if (readlinkSync(link) !== source) unlinkSync(link);
  }
  if (!existsSync(link) || !lstatSync(link).isSymbolicLink()) symlinkSync(source, link);

  const mode = statSync(source).mode;
  if ((mode & 0o111) === 0) {
    try {
      chmodSync(source, mode | 0o755);
    } catch {
      // A read-only bundle keeps its mode; the shebang still runs through `node`.
    }
  }

  const onPath = opts.pathEnv.split(delimiter).some((p) => p.replace(/\/+$/, '') === binDir);
  return { link, source, onPath, binDir };
}

/**
 * Re-points our link when its target is gone, as after the app moved.
 * A link to a copy that still exists, or a file that is not a link, stays as it is.
 */
export function repairCli(opts: { source: string; home: string }): boolean {
  const link = cliLinkPath(opts.home);
  let target: string;
  try {
    target = readlinkSync(link);
  } catch {
    return false;
  }
  if (target === opts.source || !target.endsWith('/bin/agent-brief')) return false;
  if (existsSync(resolve(dirname(link), target)) || !existsSync(opts.source) || isTranslocated(opts.source)) return false;
  unlinkSync(link);
  symlinkSync(opts.source, link);
  return true;
}
