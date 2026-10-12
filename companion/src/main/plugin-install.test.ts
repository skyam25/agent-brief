import { describe, expect, it } from 'vitest';
import { describeSource, installPlugin, isBundledPluginDir, repairPlugin, type Marketplace, type RunClaude } from './plugin-install';

const APP = '/Applications/Agent Brief.app/Contents/Resources/plugin';
const OLD = '/Users/me/Downloads/Agent Brief.app/Contents/Resources/plugin';

/** A fake `claude` that answers the list commands and records every call. */
function fakeClaude(state: { marketplaces?: Marketplace[]; plugins?: string[] }) {
  const calls: string[][] = [];
  const run: RunClaude = async (args) => {
    calls.push(args);
    const cmd = args.join(' ');
    if (cmd === 'plugin marketplace list --json') return JSON.stringify(state.marketplaces ?? []);
    if (cmd === 'plugin list --json') return JSON.stringify((state.plugins ?? []).map((id) => ({ id })));
    return '';
  };
  return { run, calls };
}

describe('installPlugin', () => {
  it('adds the marketplace and installs the plugin', async () => {
    const { run, calls } = fakeClaude({});
    expect(await installPlugin(run, APP)).toEqual({ installed: true });
    expect(calls).toEqual([
      ['plugin', 'marketplace', 'add', APP],
      ['plugin', 'list', '--json'],
      ['plugin', 'install', 'agent-brief@agent-brief'],
    ]);
  });

  it('only re-points when the plugin is already installed', async () => {
    const { run, calls } = fakeClaude({ plugins: ['agent-brief@agent-brief'] });
    expect(await installPlugin(run, APP)).toEqual({ installed: false });
    expect(calls.map((c) => c.slice(0, 2).join(' '))).toEqual(['plugin marketplace', 'plugin list']);
  });
});

describe('repairPlugin', () => {
  const dir = (path: string): Marketplace => ({ name: 'agent-brief', source: 'directory', path });

  it('re-points a registration whose app bundle is gone', async () => {
    const { run, calls } = fakeClaude({ marketplaces: [dir(OLD)] });
    expect(await repairPlugin(run, APP, () => false)).toBe(true);
    expect(calls.at(-1)).toEqual(['plugin', 'marketplace', 'add', APP]);
  });

  it('leaves checkouts, GitHub, live copies and missing registrations alone', async () => {
    const cases: Marketplace[][] = [
      [],
      [dir(APP)],
      [dir('/Users/me/Projects/agent-brief')],
      [{ name: 'agent-brief', source: 'github', repo: 'skyam25/agent-brief' }],
    ];
    for (const marketplaces of cases) {
      const { run, calls } = fakeClaude({ marketplaces });
      expect(await repairPlugin(run, APP, () => false)).toBe(false);
      expect(calls).toHaveLength(1);
    }
    const { run } = fakeClaude({ marketplaces: [dir(OLD)] });
    expect(await repairPlugin(run, APP, () => true)).toBe(false);
  });
});

describe('helpers', () => {
  it('tells a bundle from a checkout and describes sources', () => {
    expect(isBundledPluginDir(APP)).toBe(true);
    expect(isBundledPluginDir('/Users/me/Projects/agent-brief')).toBe(false);
    expect(describeSource({ name: 'agent-brief', source: 'github', repo: 'skyam25/agent-brief' })).toBe('GitHub (skyam25/agent-brief)');
    expect(describeSource({ name: 'agent-brief', source: 'directory', path: APP })).toBe(APP);
  });
});
