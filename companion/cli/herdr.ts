/**
 * Shell setup that lets Claude Code draw pictures inside Herdr panes.
 *
 * Herdr panes answer the terminal-name query as "libghostty", and Claude Code
 * only trusts "ghostty" and "kitty" with placeholder images. Herdr draws them
 * fine, so the setup sets CLAUDE_CODE_FORCE_TERMINAL_IMAGES=1, guarded by
 * HERDR_ENV so other terminals keep Claude Code's own check.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const FORCE_VAR = 'CLAUDE_CODE_FORCE_TERMINAL_IMAGES';

const START = '# >>> agent-brief herdr-pictures >>>';
const END = '# <<< agent-brief herdr-pictures <<<';
const WHY = '# Claude Code draws pictures in Herdr panes only when told to.';

export const POSIX_BLOCK = [START, WHY, `if [ -n "$HERDR_ENV" ]; then export ${FORCE_VAR}=1; fi`, END].join('\n');
export const FISH_FILE = [START, WHY, `if set -q HERDR_ENV; set -gx ${FORCE_VAR} 1; end`, END, ''].join('\n');

/** The block, its line end, and the blank line `withBlock` put before it. */
const BLOCK_RE = new RegExp(`(?:(?<=\\n)\\n)?${escape(START)}[\\s\\S]*?${escape(END)}\\n?`, 'g');

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface ShellFile {
  path: string;
  /** posix files get a block added; the fish file is ours alone. */
  kind: 'posix' | 'fish';
}

/** Startup files to change: the ones that exist, plus the login shell's own. */
export function shellFiles(
  env: Record<string, string | undefined>,
  home: string,
  exists: (p: string) => boolean = existsSync,
): ShellFile[] {
  const shell = path.basename(env.SHELL ?? '');
  const files: ShellFile[] = [];

  const zshrc = path.join(env.ZDOTDIR || home, '.zshrc');
  if (exists(zshrc) || shell === 'zsh') files.push({ path: zshrc, kind: 'posix' });

  const bash = ['.bashrc', '.bash_profile'].map((f) => path.join(home, f));
  const bashFound = bash.filter(exists);
  if (bashFound.length === 0 && shell === 'bash') bashFound.push(bash[1]);
  for (const p of bashFound) files.push({ path: p, kind: 'posix' });

  const fishDir = path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'fish');
  if (exists(fishDir) || shell === 'fish') {
    files.push({ path: path.join(fishDir, 'conf.d', 'agent-brief-herdr.fish'), kind: 'fish' });
  }

  if (files.length === 0) files.push({ path: zshrc, kind: 'posix' });
  return files;
}

export const hasBlock = (text: string) => text.includes(START);

/** The file's text with the block added, or removed when `on` is false. Other lines stay as they were. */
export function withBlock(text: string, on: boolean): string {
  const stripped = text.replace(BLOCK_RE, '');
  if (!on) return stripped;
  if (stripped === '') return `${POSIX_BLOCK}\n`;
  return `${stripped}${stripped.endsWith('\n') ? '' : '\n'}\n${POSIX_BLOCK}\n`;
}

async function readOrEmpty(p: string): Promise<string | undefined> {
  try {
    return await readFile(p, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}

export type Change = 'added' | 'already' | 'removed' | 'absent';

/** Adds (`on`) or removes the setup in one file. */
export async function apply(file: ShellFile, on: boolean): Promise<Change> {
  const text = await readOrEmpty(file.path);
  const present = text !== undefined && hasBlock(text);
  if (on && present && (file.kind === 'fish' ? text === FISH_FILE : text.includes(POSIX_BLOCK))) return 'already';
  if (!on && !present) return 'absent';

  if (file.kind === 'fish') {
    if (on) {
      await mkdir(path.dirname(file.path), { recursive: true });
      await writeFile(file.path, FISH_FILE);
    } else {
      await rm(file.path);
    }
  } else {
    await mkdir(path.dirname(file.path), { recursive: true });
    await writeFile(file.path, withBlock(text ?? '', on));
  }
  return on ? 'added' : 'removed';
}

/** Whether a file has the setup now. */
export async function isOn(file: ShellFile): Promise<boolean> {
  const text = await readOrEmpty(file.path);
  return text !== undefined && hasBlock(text);
}
