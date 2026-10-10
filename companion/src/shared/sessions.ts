/** Words for a Claude Code session in the panel. */

import type { SessionHost, SessionInfo } from '../protocol';

const TERMINALS: Record<string, string> = {
  ghostty: 'Ghostty',
  'iTerm.app': 'iTerm',
  Apple_Terminal: 'Terminal',
  vscode: 'VS Code',
  WezTerm: 'WezTerm',
  WarpTerminal: 'Warp',
  tmux: 'tmux',
};

/** Where the session runs, such as `herdr` or `Ghostty`. */
export function hostLabel(host: SessionHost | undefined): string | undefined {
  if (host?.herdrPane) return 'herdr';
  if (!host?.terminal) return undefined;
  return TERMINALS[host.terminal] ?? host.terminal;
}

/** The last folder of a path. */
export function folderName(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path;
}

/** `~/Projects/app` for a path under the home folder. */
export function shortPath(path: string, home?: string): string {
  return home && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/** The project and where it runs, as in `webAgentCompanion · Ghostty`. */
export function sessionTitle(s: SessionInfo): string {
  return [s.title || folderName(s.cwd), hostLabel(s.host)].filter(Boolean).join(' · ');
}
