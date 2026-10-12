/** The terminals Claude Code sessions run in: starting, resuming and focusing them. */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SessionInfo } from '../protocol';
import type { Launcher, SendResult } from '../shared/ipc';
import { isGhostty } from '../shared/sessions';
import { findTool } from '../voice/compose';
import { exec, focusSession, frontGhosttyTerminal, resumeCommand, resumeSession, startSession, type Exec } from './launch';

export const LAUNCHER_NAMES: Record<Launcher, string> = { ghostty: 'Ghostty', terminal: 'Terminal', herdr: 'herdr', copy: 'the clipboard' };

const herdrPath = () => findTool('herdr', [join(homedir(), '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin']);

export class Terminals {
  /** Commands a test run recorded in place of opening terminals. */
  readonly launches: { file: string; args: string[] }[] = [];
  /** What a test run copied, in place of the clipboard. */
  copied: string | undefined;
  private readonly run: Exec;
  /** Ghostty terminal ids captured when a session runs /sketch, for jumping back to it. */
  private readonly ghostty = new Map<string, string>();

  constructor(private readonly opts: { testMode: boolean; writeClipboard: (text: string) => void }) {
    this.run = opts.testMode
      ? async (file, args) => {
          this.launches.push({ file, args });
          return args[0] === 'tab' ? JSON.stringify({ result: { root_pane: { pane_id: 'w1:p9' } } }) : '';
        }
      : exec;
  }

  /** The ways this Mac can start a session, best first. */
  launchers(): Launcher[] {
    if (this.opts.testMode) return ['ghostty', 'terminal', 'herdr', 'copy'];
    const ghostty = ['/Applications', join(homedir(), 'Applications')].some((d) => existsSync(join(d, 'Ghostty.app')));
    return [...(ghostty ? (['ghostty'] as const) : []), 'terminal', ...(herdrPath() ? (['herdr'] as const) : []), 'copy'];
  }

  /** Records the Ghostty terminal in front as the session's. Call it while the user is still typing there. */
  async capture(session: SessionInfo): Promise<void> {
    if (!isGhostty(session.host)) return;
    const id = await frontGhosttyTerminal(this.run, session.cwd);
    if (id) this.ghostty.set(session.sessionId, id);
  }

  /** Forgets the terminals of sessions that ended. */
  keepOnly(live: string[]): void {
    for (const id of this.ghostty.keys()) if (!live.includes(id)) this.ghostty.delete(id);
  }

  async focus(session: SessionInfo): Promise<void> {
    await focusSession(this.run, session, { herdr: herdrPath(), ghosttyTerminal: this.ghostty.get(session.sessionId) }).catch((err) =>
      console.warn(`[companion] could not focus the session: ${(err as Error).message}`),
    );
  }

  copy(text: string): void {
    if (this.opts.testMode) this.copied = text;
    else this.opts.writeClipboard(text);
  }

  /** Starts Claude Code in `cwd` on the prompt file. */
  start(via: Exclude<Launcher, 'copy'>, cwd: string, promptPath: string): Promise<void> {
    return startSession(this.run, via, cwd, promptPath, herdrPath());
  }

  /** Resumes an ended session in `cwd`, or copies the command that does. */
  async resume(sessionId: string, cwd: string, via: Launcher): Promise<SendResult> {
    if (!Object.hasOwn(LAUNCHER_NAMES, via)) return { ok: false, message: `Cannot resume through ${String(via)}` };
    if (via === 'copy') {
      this.copy(resumeCommand(cwd, sessionId));
      return { ok: true, message: 'Copied the resume command' };
    }
    if (!existsSync(cwd)) return { ok: false, message: `No folder at ${cwd}` };
    try {
      await resumeSession(this.run, via, cwd, sessionId, herdrPath());
      return { ok: true, message: `Resuming the session in ${LAUNCHER_NAMES[via]}` };
    } catch (err) {
      return { ok: false, message: `Could not resume the session: ${(err as Error).message}` };
    }
  }
}
