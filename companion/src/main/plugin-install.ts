/**
 * Registers the Claude Code plugin that ships inside the app.
 *
 * Claude Code reads a directory marketplace's plugins in place, so a
 * registration that points into the bundle updates whenever the app does.
 * Adding a marketplace under a name that exists re-points it and keeps the
 * installed plugin and its options. Removing one deletes the options, so this
 * module never removes.
 */

import { existsSync } from 'node:fs';

export const MARKETPLACE = 'agent-brief';
export const PLUGIN_ID = 'agent-brief@agent-brief';

/** Runs `claude` with these arguments and resolves its stdout. */
export type RunClaude = (args: string[]) => Promise<string>;

export interface Marketplace {
  name: string;
  source: string;
  path?: string;
  repo?: string;
  url?: string;
}

export async function agentBriefMarketplace(run: RunClaude): Promise<Marketplace | undefined> {
  const list = JSON.parse(await run(['plugin', 'marketplace', 'list', '--json'])) as Marketplace[];
  return list.find((m) => m.name === MARKETPLACE);
}

/** Where a marketplace comes from, as a dialog shows it. */
export function describeSource(m: Marketplace): string {
  if (m.source === 'github' && m.repo) return `GitHub (${m.repo})`;
  return m.path ?? m.url ?? m.source;
}

/** True for the plugin folder inside an app bundle, as opposed to a checkout. */
export function isBundledPluginDir(path: string): boolean {
  return /\.app\/Contents\/Resources\/plugin\/?$/.test(path);
}

/** Points the marketplace at `dir`, then installs the plugin unless it already is. */
export async function installPlugin(run: RunClaude, dir: string): Promise<{ installed: boolean }> {
  await run(['plugin', 'marketplace', 'add', dir]);
  const plugins = JSON.parse(await run(['plugin', 'list', '--json'])) as { id: string }[];
  if (plugins.some((p) => p.id === PLUGIN_ID)) return { installed: false };
  await run(['plugin', 'install', PLUGIN_ID]);
  return { installed: true };
}

/**
 * Re-points a registration whose app bundle is gone, as after the app moved.
 * Checkouts, GitHub sources and copies that still exist stay as they are.
 */
export async function repairPlugin(run: RunClaude, dir: string, exists = existsSync): Promise<boolean> {
  const m = await agentBriefMarketplace(run);
  if (m?.source !== 'directory' || !m.path || m.path === dir) return false;
  if (!isBundledPluginDir(m.path) || exists(m.path)) return false;
  await run(['plugin', 'marketplace', 'add', dir]);
  return true;
}
