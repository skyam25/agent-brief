// Readies a fresh git worktree for tests and releases: dependencies, a working
// Electron binary, the plugin's engine types, and the built CLI that the CLI
// unit tests run.
//
//   pnpm setup:worktree
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ensureElectron } from './electron.mjs';

const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' });

run('pnpm', ['install', '--frozen-lockfile']);
ensureElectron();

// Claude Code writes these only when a session loads the plugin, and they are
// untracked, so a new worktree takes the main checkout's copy.
const TYPES = 'mod/agent-brief/.claude-plugin/types';
const here = join('..', TYPES);
if (!existsSync(here)) {
  const main = execFileSync('git', ['worktree', 'list', '--porcelain'], { encoding: 'utf8' }).split('\n')[0].replace(/^worktree /, '');
  const source = join(main, TYPES);
  if (existsSync(source)) cpSync(source, here, { recursive: true });
  else console.log(`No ${TYPES} in ${main}. Start a session with --plugin-dir once to write them.`);
}

run('pnpm', ['build']);
