// Builds the notarized app and installs it into /Applications in place of the
// running copy.
//
//   pnpm install:local            # build, notarize, install
//   pnpm install:local --no-build # install the existing dist/ build
//
// The old bundle moves to the Trash first. Copying over it merges stale files
// and breaks the code seal.
import { execFileSync } from 'node:child_process';
import { existsSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const APP = '/Applications/Agent Brief.app';
const BUILT = 'dist/mac-arm64/Agent Brief.app';
const BUNDLE_ID = 'com.agentbrief.app';

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const running = () => {
  try {
    execFileSync('pgrep', ['-f', `${APP}/Contents/MacOS/`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

const args = process.argv.slice(2);
if (args.some(a => a !== '--no-build')) {
  console.log('Usage: pnpm install:local [--no-build]');
  process.exit(args.includes('--help') ? 0 : 1);
}

if (!args.includes('--no-build')) run('pnpm', ['dist:notarize']);
if (!existsSync(BUILT)) throw new Error(`missing ${BUILT}`);
run('codesign', ['--verify', '--deep', '--strict', BUILT]);
run('spctl', ['--assess', '--type', 'execute', BUILT]);

if (running()) {
  execFileSync('osascript', ['-e', `tell application id "${BUNDLE_ID}" to quit`], { stdio: 'ignore' });
  for (let i = 0; i < 20 && running(); i++) await sleep(500);
  if (running()) {
    console.log('Agent Brief ignored quit. Stopping it.');
    run('pkill', ['-f', `${APP}/Contents/MacOS/`]);
    await sleep(1000);
  }
}

if (existsSync(APP)) renameSync(APP, join(homedir(), '.Trash', `Agent Brief ${Date.now()}.app`));
run('ditto', [BUILT, APP]);
run('codesign', ['--verify', '--deep', '--strict', APP]);
run('open', [APP]);

const version = execFileSync('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', `${APP}/Contents/Info.plist`], { encoding: 'utf8' }).trim();
console.log(`Installed Agent Brief ${version}. Open Claude Code sessions keep the old plugin until /reload-plugins.`);
