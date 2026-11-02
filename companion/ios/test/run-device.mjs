// The whole loop on a real iPad: the real Mac side, real on-device speech from a file, and a real microphone start.
// Run from companion/ after pnpm build and pnpm build:ipad: node ios/test/run-device.mjs <udid>
// The iPad must be unlocked and on the Mac's network.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const udid = process.argv[2];
if (!udid) throw new Error('usage: run-device.mjs <udid>');

const here = dirname(fileURLToPath(import.meta.url));
const ios = join(here, '..');
const companion = join(ios, '..');
const dir = join(here, '.run-device');
const prompt = 'Mark up the sign-up flow';
const prompt2 = 'Second hand-off for the microphone';
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed:\n${(r.stdout ?? '').slice(-2000)}\n${(r.stderr ?? '').slice(-2000)}`);
  return r.stdout;
};

// xcodebuild waits two hours on a locked iPad before it fails.
const lock = run('xcrun', ['devicectl', 'device', 'info', 'lockState', '--device', udid]);
if (/passcodeRequired: true/.test(lock)) {
  console.error('DEVICE LOOP NOT RUN: unlock the iPad first');
  process.exit(2);
}

const wav = join(dir, 'speech.wav');
run('say', ['-o', wav, '--data-format=LEI16@16000', 'Circle the sign up button. This step needs a clearer error message.']);

const signed = ['-project', 'AgentBrief.xcodeproj', '-scheme', 'AgentBrief', '-destination', `id=${udid}`, '-derivedDataPath', 'build-device', '-allowProvisioningUpdates'];
console.log('building for the device');
run('xcodebuild', ['build-for-testing', ...signed], { cwd: ios, maxBuffer: 1 << 28 });
const app = join(ios, 'build-device/Build/Products/Debug-iphoneos/AgentBrief.app');
run('xcrun', ['devicectl', 'device', 'install', 'app', '--device', udid, app]);
run('xcrun', ['devicectl', 'device', 'copy', 'to', '--device', udid, '--domain-type', 'appDataContainer', '--domain-identifier', 'com.skyam25.agentbrief', '--source', wav, '--destination', 'Documents/speech.wav']);

const stub = spawn('node', ['live/ipad-stub.mjs', '--prompt', prompt], { cwd: companion, stdio: ['ignore', 'pipe', 'inherit'] });
let out = '';
stub.stdout.on('data', (d) => {
  out += d;
  process.stdout.write(d);
});
const info = await new Promise((resolve, reject) => {
  const timer = setInterval(() => {
    const start = out.indexOf('{');
    const end = out.indexOf('\n}', start);
    if (start < 0 || end < 0) return;
    clearInterval(timer);
    resolve(JSON.parse(out.slice(start, end + 2)));
  }, 200);
  stub.on('exit', (code) => reject(new Error(`stub exited ${code}`)));
});

const finish = (code) => {
  stub.kill('SIGTERM');
  process.exit(code);
};

const seconds = (ms) => new Promise((r) => setTimeout(r, ms));
const cli = join(companion, 'bin/agent-brief.mjs');
const second = setInterval(() => {
  const paired = spawnSync('node', [cli, 'ipad'], { env: { ...process.env, COMPANION_SOCKET: info.socket }, encoding: 'utf8' });
  if (!/iPad|device/i.test(paired.stdout ?? '') || /no ipad/i.test(paired.stdout ?? '')) return;
  const made = spawnSync('node', [cli, 'handoff', '--session', info.session, '--prompt', prompt2], { env: { ...process.env, COMPANION_SOCKET: info.socket }, encoding: 'utf8' });
  if (made.status === 0) clearInterval(second);
}, 2000);

const result = join(dir, 'run.xcresult');
const test = spawn('xcodebuild', ['test-without-building', ...signed, '-resultBundlePath', result, '-only-testing:AgentBriefUITests/DeviceLoopTests'], {
  cwd: ios,
  env: { ...process.env, TEST_RUNNER_AB_PAIR_URL: info.pairUrl, TEST_RUNNER_AB_PROMPT: prompt, TEST_RUNNER_AB_PROMPT_2: prompt2 },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
const take = (d) => (log = (log + d).slice(-6000));
test.stdout.on('data', take);
test.stderr.on('data', take);
const code = await new Promise((r) => test.on('close', r));
clearInterval(second);
console.log(code === 0 ? 'xcodebuild test passed' : log);
spawnSync('xcrun', ['xcresulttool', 'export', 'attachments', '--path', result, '--output-path', join(dir, 'shots')], { stdio: 'inherit' });

await seconds(2000);
const sketches = join(info.project, '.feedback/sketches');
const bundles = existsSync(sketches) ? readdirSync(sketches) : [];
console.log(`bundles: ${bundles.join(', ') || 'none'}`);
let ok = code === 0 && bundles.length > 0;
for (const id of bundles) {
  const timeline = join(sketches, id, 'timeline.md');
  const text = existsSync(timeline) ? readFileSync(timeline, 'utf8') : '';
  console.log(`--- ${id}\n${readdirSync(join(sketches, id)).join(', ')}\n${text}`);
  if (!/sign.?up/i.test(text)) ok = false;
}
console.log(ok ? 'DEVICE LOOP PASSED' : 'DEVICE LOOP FAILED');
finish(ok ? 0 : 1);
