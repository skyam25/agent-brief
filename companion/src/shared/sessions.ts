/** Words for a Claude Code session in the panel. */

import type { PrototypeFidelity, SessionHost, SessionInfo, SessionMode } from '../protocol';

const TERMINALS: Record<string, string> = {
  ghostty: 'Ghostty',
  'iTerm.app': 'iTerm',
  Apple_Terminal: 'Terminal',
  vscode: 'VS Code',
  WezTerm: 'WezTerm',
  WarpTerminal: 'Warp',
  tmux: 'tmux',
};

const MODES: Record<SessionMode, string> = {
  default: '',
  product: 'Product',
  prototype: 'Prototype',
  orchestrate: 'Orchestrate',
};

const FIDELITIES: Record<PrototypeFidelity, string> = {
  wireframe: 'Wireframe',
  styled: 'Styled HTML',
  'live-patch': 'Live patch',
  'freeze-patch': 'Freeze + patch',
  interactive: 'Interactive',
  existing: 'Existing',
};

const GHOSTTY_BUNDLE = 'com.mitchellh.ghostty';

/** True for a session in Ghostty, including one under tmux there. */
export const isGhostty = (host: SessionHost | undefined) => host?.bundleId === GHOSTTY_BUNDLE || host?.terminal === 'ghostty';

/** Where the session runs, such as `herdr` or `Ghostty`. */
export function hostLabel(host: SessionHost | undefined): string | undefined {
  if (host?.herdrPane) return 'herdr';
  if (!host?.terminal) return undefined;
  return TERMINALS[host.terminal] ?? host.terminal;
}

/** The session's mode as its chip reads, such as `Prototype · Wireframe`. Undefined in default mode. */
export function modeLabel(mode: SessionMode | undefined, fidelity?: PrototypeFidelity): string | undefined {
  if (!mode || !MODES[mode]) return undefined;
  const detail = mode === 'prototype' && fidelity ? FIDELITIES[fidelity] : undefined;
  return detail ? `${MODES[mode]} · ${detail}` : MODES[mode];
}

/** The last folder of a path. */
export function folderName(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path;
}

/** `~/Projects/app` for a path under the home folder. */
export function shortPath(path: string, home?: string): string {
  return home && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/** The project and where it runs, as in `agent-brief · Ghostty`. */
export function sessionTitle(s: SessionInfo): string {
  return [s.title || folderName(s.cwd), hostLabel(s.host)].filter(Boolean).join(' · ');
}

/** The last two folders, from `~` when that is all there is: `~/Projects/app`, `…/web/app`. */
export function shortFolder(path: string, home?: string): string {
  const short = shortPath(path, home);
  const parts = short.split('/').filter(Boolean);
  if (parts.length <= 2) return short;
  if (short.startsWith('~/') && parts.length === 3) return short;
  return `…/${parts.slice(-2).join('/')}`;
}

/**
 * A hue from 0 to 359 that stays the same for one session, so its avatar keeps
 * its color. Steps of the golden angle keep near-identical ids far apart.
 */
export function hueOf(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return Math.round((h % 1000) * 137.508) % 360;
}
