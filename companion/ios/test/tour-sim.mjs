// Walks the app through each screen on a simulator and writes screenshots. Asserts nothing about the product.
// Run from companion/: node ios/test/tour-sim.mjs <out-dir> [light|dark] [landscape|portrait]
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStub } from './stub-server.mjs';

const [outArg, look = 'light', orientation = 'landscape'] = process.argv.slice(2);
if (!outArg) throw new Error('usage: tour-sim.mjs <out-dir> [light|dark] [landscape|portrait]');
const out = resolve(outArg);
const ios = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(ios, 'test', '.tour');
const simName = process.env.AB_SIM_NAME ?? 'iPad Pro 11-inch (M5)';

const simctl = (...args) => execFileSync('xcrun', ['simctl', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const runtimes = JSON.parse(simctl('list', 'devices', 'available', '-j')).devices;
const runtime = Object.keys(runtimes).find((r) => r.endsWith('iOS-27-2'));
const udid = runtimes[runtime].find((d) => d.name === simName).udid;

rmSync(dir, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
mkdirSync(dir, { recursive: true });

simctl('bootstatus', udid, '-b');
simctl('ui', udid, 'appearance', look);
simctl('privacy', udid, 'grant', 'microphone', 'com.skyam25.agentbrief');

const extra = [
  { id: 'h3', sessionLabel: 'checkout: payment retry', prompt: 'Sketch how the retry banner should sit above the order summary when the card fails, and mark which fields keep their values after the error clears' },
  { id: 'h4', sessionLabel: 'docs site' },
];
const stub = await startStub({ dir, extra });
const second = await startStub({ dir: join(dir, 'mac-b'), macName: 'Studio Mac', promptPrefix: 'Studio: ' });

const env = {
  ...process.env,
  TEST_RUNNER_AB_PAIR_URL: stub.pairUrl,
  TEST_RUNNER_AB_PAIR_URL_B: second.pairUrl,
  TEST_RUNNER_AB_STUB_DIR: dir,
  TEST_RUNNER_AB_TOUR_DIR: out,
  TEST_RUNNER_AB_TOUR_ORIENTATION: orientation,
  TEST_RUNNER_AB_TEST_PHRASES: 'Circle the sign up button|This step needs a clearer error',
};
const log = join(out, 'xcodebuild.log');
rmSync(log, { force: true });

// The test writes the name of each screen here and waits.
const request = join(dir, 'shot-request');
const shooter = setInterval(() => {
  if (!existsSync(request)) return;
  const file = join(out, `${readFileSync(request, 'utf8')}.png`);
  simctl('io', udid, 'screenshot', file);
  rmSync(request);
}, 100);
const code = await new Promise((done) => {
  const child = spawn(
    'xcodebuild',
    ['test', '-project', 'AgentBrief.xcodeproj', '-scheme', 'AgentBrief', '-destination', `platform=iOS Simulator,id=${udid}`, '-derivedDataPath', 'build', '-parallel-testing-enabled', 'NO', '-only-testing:AgentBriefUITests/ScreenTourTests', 'CODE_SIGN_STYLE=Manual', 'CODE_SIGN_IDENTITY=-', 'DEVELOPMENT_TEAM='],
    { cwd: ios, env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  child.stdout.on('data', (d) => appendFileSync(log, d));
  child.stderr.on('data', (d) => appendFileSync(log, d));
  child.on('close', done);
});
clearInterval(shooter);
for (const s of [stub, second]) {
  s.server.close();
  s.server.closeAllConnections();
}
console.log(code === 0 ? `screens in ${out}` : `tour failed, see ${log}`);
process.exit(code === 0 ? 0 : 1);
