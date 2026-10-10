/** Starts a new Claude Code session on a sketch, and brings an existing session's terminal forward. */

import { execFile } from 'node:child_process';
import type { SessionHost } from '../protocol';
import type { Launcher } from '../shared/ipc';

export const GHOSTTY_BUNDLE = 'com.mitchellh.ghostty';

/** Runs a program and resolves with its stdout. */
export type Exec = (file: string, args: string[]) => Promise<string>;

export const exec: Exec = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 15_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()));
      else resolve(stdout);
    });
  });

/** Quotes a string for a POSIX shell. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Quotes a string for AppleScript. */
export function appleQuote(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Starts Claude Code with the prompt file's text as the first message. */
export function claudeCommand(promptPath: string): string {
  return `claude "$(cat ${shellQuote(promptPath)})"`;
}

/** What Copy puts on the clipboard: a line to paste into any terminal. */
export function startCommand(cwd: string, promptPath: string): string {
  return `cd ${shellQuote(cwd)} && ${claudeCommand(promptPath)}`;
}

export function ghosttyScript(cwd: string, promptPath: string): string {
  return [
    'tell application "Ghostty"',
    '  set cfg to new surface configuration',
    `  set initial working directory of cfg to ${appleQuote(cwd)}`,
    `  set initial input of cfg to ${appleQuote(`${claudeCommand(promptPath)}\n`)}`,
    '  new window with configuration cfg',
    '  activate',
    'end tell',
  ].join('\n');
}

export function terminalScript(cwd: string, promptPath: string): string {
  return [
    'tell application "Terminal"',
    `  do script ${appleQuote(startCommand(cwd, promptPath))}`,
    '  activate',
    'end tell',
  ].join('\n');
}

/** Opens a herdr tab in `cwd` and starts Claude Code in it. */
export async function startInHerdr(run: Exec, herdr: string, cwd: string, promptPath: string): Promise<void> {
  const created = JSON.parse(await run(herdr, ['tab', 'create', '--cwd', cwd, '--label', 'sketch', '--focus'])) as {
    result?: { root_pane?: { pane_id?: string } };
  };
  const pane = created.result?.root_pane?.pane_id;
  if (!pane) throw new Error('herdr did not return the new pane');
  await run(herdr, ['pane', 'run', pane, claudeCommand(promptPath)]);
}

export async function startSession(
  run: Exec,
  via: Exclude<Launcher, 'copy'>,
  cwd: string,
  promptPath: string,
  herdr?: string,
): Promise<void> {
  if (via === 'ghostty') await run('osascript', ['-e', ghosttyScript(cwd, promptPath)]);
  else if (via === 'terminal') await run('osascript', ['-e', terminalScript(cwd, promptPath)]);
  else {
    if (!herdr) throw new Error('herdr is not installed');
    await startInHerdr(run, herdr, cwd, promptPath);
  }
}

/**
 * The focused terminal's id when Ghostty is frontmost and that terminal is in
 * `cwd`, else ''. Run when the user types `/sketch`, it names that session's terminal.
 */
export function ghosttyFrontScript(cwd: string): string {
  return [
    'tell application "Ghostty"',
    '  if not frontmost then return ""',
    '  set t to focused terminal of selected tab of front window',
    `  if working directory of t is not ${appleQuote(cwd)} then return ""`,
    '  return id of t',
    'end tell',
  ].join('\n');
}

/** Focuses the known terminal, else the only one in `cwd`, and brings Ghostty forward. */
export function ghosttyFocusScript(cwd: string, terminalId?: string): string {
  return [
    'tell application "Ghostty"',
    ...(terminalId
      ? [
          `  set found to every terminal whose id is ${appleQuote(terminalId)}`,
          '  if (count of found) is 0 then',
          `    set found to every terminal whose working directory is ${appleQuote(cwd)}`,
          '  end if',
        ]
      : [`  set found to every terminal whose working directory is ${appleQuote(cwd)}`]),
    '  if (count of found) is 1 then',
    '    focus item 1 of found',
    '  end if',
    '  activate',
    'end tell',
  ].join('\n');
}

/** The Ghostty terminal in front, when it belongs to this session's folder. */
export async function frontGhosttyTerminal(run: Exec, cwd: string): Promise<string | undefined> {
  const id = (await run('osascript', ['-e', ghosttyFrontScript(cwd)]).catch(() => '')).trim();
  return id || undefined;
}

/**
 * Brings a session's terminal forward. A herdr pane is focused exactly. A
 * Ghostty terminal is focused when its id was captured or it is the only one in
 * that folder. Any other app is brought forward as a whole.
 */
export async function focusSession(
  run: Exec,
  session: { cwd: string; host?: SessionHost },
  opts: { herdr?: string; ghosttyTerminal?: string } = {},
): Promise<boolean> {
  const host = session.host ?? {};
  if (host.herdrPane && opts.herdr) await run(opts.herdr, ['agent', 'focus', host.herdrPane]).catch(() => undefined);
  if (isGhostty(host)) {
    await run('osascript', ['-e', ghosttyFocusScript(session.cwd, opts.ghosttyTerminal)]);
    return true;
  }
  if (host.bundleId) {
    await run('open', ['-b', host.bundleId]);
    return true;
  }
  return !!host.herdrPane;
}

export const isGhostty = (host: SessionHost | undefined) =>
  host?.bundleId === GHOSTTY_BUNDLE || host?.terminal === 'ghostty';
