/** Installing and repairing the agent-brief CLI link and the Claude Code plugin the app ships. */

import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { app, type BrowserWindow, dialog, type MessageBoxOptions } from 'electron';
import { findTool } from '../voice/compose';
import { cliLinkPath, installCli, isTranslocated, MOVE_APP_FIRST, repairCli, type InstallResult } from './cli-install';
import { agentBriefMarketplace, describeSource, installPlugin, repairPlugin, type RunClaude } from './plugin-install';

export interface PluginInstall {
  installed: boolean;
  cli?: InstallResult;
  cliError?: string;
}

export interface Installs {
  /** Links the CLI. With `confirm`, asks first and reports in dialogs; without, throws. */
  installCli(opts: { confirm: boolean; home?: string }): Promise<InstallResult | undefined>;
  /**
   * Registers the plugin with Claude Code and links the CLI, which the plugin's skills call.
   * With `confirm`, asks first and reports in dialogs; without, throws. A failed link never fails the plugin.
   */
  installPlugin(opts: { confirm: boolean; home?: string }): Promise<PluginInstall | undefined>;
  /** A moved app leaves the CLI link and the plugin registration pointing at nothing. This points them here. */
  repair(): Promise<void>;
}

/** The CLI script: inside the app bundle when packaged, else the repo's build. */
function cliSource(): string {
  return app.isPackaged ? join(process.resourcesPath, 'bin/agent-brief') : join(app.getAppPath(), 'bin/agent-brief');
}

/** The plugin marketplace: inside the app bundle when packaged, else the repo root. */
function pluginSource(): string {
  return app.isPackaged ? join(process.resourcesPath, 'plugin') : resolve(app.getAppPath(), '..');
}

/** `dialogParent` returns the window each dialog opens on, shown and in front, so no dialog hides behind other apps. */
export function createInstalls(testMode: boolean, dialogParent: () => BrowserWindow): Installs {
  const showDialog = (opts: MessageBoxOptions) => dialog.showMessageBox(dialogParent(), opts);
  const showError = (message: string, detail: string) => void showDialog({ type: 'error', message, detail });

  /** PATH as the user's login shell sets it. GUI apps start with a much shorter one. */
  const loginShellPath = (): Promise<string> => {
    const fallback = process.env.PATH ?? '';
    if (testMode) return Promise.resolve(fallback);
    return new Promise((done) => {
      execFile(process.env.SHELL || '/bin/zsh', ['-ilc', 'printf %s "$PATH"'], { timeout: 3000 }, (err, stdout) =>
        done(err || !stdout ? fallback : stdout.trim().split('\n').pop()!),
      );
    });
  };

  /** Runs the user's `claude`, or undefined when it is not installed. Test runs use COMPANION_TEST_CLAUDE. */
  const claudeRunner = async (): Promise<RunClaude | undefined> => {
    const pathEnv = await loginShellPath();
    const bin = testMode
      ? process.env.COMPANION_TEST_CLAUDE
      : findTool('claude', [join(homedir(), '.local/bin'), ...pathEnv.split(delimiter)]);
    if (!bin) return undefined;
    return (args) =>
      new Promise((ok, fail) =>
        execFile(bin, args, { env: { ...process.env, PATH: pathEnv }, timeout: 60_000 }, (err, stdout, stderr) =>
          err ? fail(new Error(stderr.trim() || err.message)) : ok(stdout),
        ),
      );
  };

  /** Advice for a link whose folder is missing from PATH. */
  const pathAdvice = (r: InstallResult): string =>
    `${r.binDir} is not on your PATH. Add this line to ~/.zshrc:\n\nexport PATH="$HOME/.local/bin:$PATH"`;

  return {
    async installCli(opts) {
      const home = opts.home ?? homedir();
      const source = cliSource();
      if (opts.confirm) {
        const { response } = await showDialog({
          type: 'question',
          buttons: ['Install', 'Cancel'],
          defaultId: 0,
          cancelId: 1,
          message: 'Install the agent-brief command line tool?',
          detail: `This links ${cliLinkPath(home)} to ${source}, so Claude Code can run \`agent-brief\`.`,
        });
        if (response !== 0) return undefined;
      }
      try {
        const result = installCli({ source, home, pathEnv: await loginShellPath() });
        if (opts.confirm) {
          await showDialog({
            type: 'info',
            message: 'Installed the agent-brief command',
            detail: result.onPath ? `${result.link} is ready.` : `${result.link} is ready, but ${pathAdvice(result)}`,
          });
        }
        return result;
      } catch (err) {
        if (opts.confirm) showError('Could not install the agent-brief command', (err as Error).message);
        else throw err;
        return undefined;
      }
    },

    async installPlugin(opts) {
      const dir = pluginSource();
      const fail = (message: string): undefined => {
        if (!opts.confirm) throw new Error(message);
        showError('Could not install the Claude Code plugin', message);
        return undefined;
      };
      if (isTranslocated(dir)) return fail(MOVE_APP_FIRST);
      const run = await claudeRunner();
      if (!run) return fail('Agent Brief could not find the claude command. Install Claude Code, then try again.');
      try {
        if (opts.confirm) {
          const current = await agentBriefMarketplace(run).catch(() => undefined);
          const moves = current && current.path !== dir;
          const { response } = await showDialog({
            type: 'question',
            buttons: ['Install', 'Cancel'],
            defaultId: 0,
            cancelId: 1,
            message: 'Install the Agent Brief plugin for Claude Code?',
            detail: [
              'Claude Code will load the plugin from inside this app, so the plugin updates whenever the app does.',
              `The agent-brief command, which Claude uses to draw on your board, goes in ${cliLinkPath(opts.home ?? homedir())}.`,
              moves ? `Claude Code loads it from ${describeSource(current)} now. Its settings carry over.` : '',
            ]
              .filter(Boolean)
              .join('\n\n'),
          });
          if (response !== 0) return undefined;
        }
        const result: PluginInstall = await installPlugin(run, dir);
        try {
          result.cli = installCli({ source: cliSource(), home: opts.home ?? homedir(), pathEnv: await loginShellPath() });
        } catch (err) {
          result.cliError = (err as Error).message;
        }
        if (opts.confirm) {
          const cli = result.cliError
            ? `The agent-brief command was not installed. ${result.cliError}`
            : result.cli && !result.cli.onPath
              ? `The agent-brief command is installed, but ${pathAdvice(result.cli)}`
              : '';
          await showDialog({
            type: 'info',
            message: 'Installed the Agent Brief plugin',
            detail: [
              'New Claude Code sessions load it. In a session that is already open, run /reload-plugins.',
              'Then run /sketch, or press Sketch above the prompt.',
              cli,
            ]
              .filter(Boolean)
              .join('\n\n'),
          });
        }
        return result;
      } catch (err) {
        return fail((err as Error).message);
      }
    },

    async repair() {
      try {
        if (repairCli({ source: cliSource(), home: homedir() })) console.log('[companion] re-pointed the agent-brief link');
      } catch (err) {
        console.warn(`[companion] could not repair the agent-brief link: ${(err as Error).message}`);
      }
      const run = await claudeRunner();
      if (!run) return;
      await repairPlugin(run, pluginSource()).then(
        (moved) => moved && console.log('[companion] re-pointed the Claude Code plugin'),
        (err: Error) => console.warn(`[companion] could not repair the Claude Code plugin: ${err.message}`),
      );
    },
  };
}
