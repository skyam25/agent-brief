/** Links the `companion` CLI into `~/.local/bin`. */

import { chmodSync, existsSync, lstatSync, mkdirSync, readlinkSync, statSync, symlinkSync, unlinkSync } from 'node:fs';
import { delimiter, join } from 'node:path';

export interface InstallResult {
  link: string;
  source: string;
  /** False when the folder is missing from PATH, so the user must add it. */
  onPath: boolean;
  binDir: string;
}

export function cliLinkPath(home: string): string {
  return join(home, '.local', 'bin', 'companion');
}

/** Creates or refreshes the link. Refuses to replace a real file that is not ours. */
export function installCli(opts: { source: string; home: string; pathEnv: string }): InstallResult {
  const { source, home } = opts;
  if (!existsSync(source)) throw new Error(`The CLI is missing at ${source}. Run pnpm build:cli.`);
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
