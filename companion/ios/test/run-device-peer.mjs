// The peer route on a real device: the real Mac side with its peer helper, and a pairing link whose hosts never answer.
// The device keeps the pairings it has. The test adds the stub Mac and forgets only that Mac.
// Run from companion/ after pnpm build and pnpm build:ipad: node ios/test/run-device-peer.mjs <udid> | --sim [destination]
// The device must be unlocked. It prints which Mac interface carried the device's connections.
import { execFile, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const sim = process.argv[2] === '--sim';
const udid = sim ? undefined : process.argv[2];
if (!sim && !udid) throw new Error('usage: run-device-peer.mjs <udid> | --sim [destination]');

const here = dirname(fileURLToPath(import.meta.url));
const ios = join(here, '..');
const companion = join(ios, '..');
const dir = join(here, sim ? '.run-sim-peer' : `.run-device-peer-${udid}`);
const helper = join(companion, 'bin/agent-brief-peer');
const prompt = `Peer check ${new Date().toISOString().slice(11, 19)}`;
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 28, ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed:\n${(r.stdout ?? '').slice(-2000)}\n${(r.stderr ?? '').slice(-2000)}`);
  return r.stdout;
};

if (!existsSync(helper)) throw new Error('build the helper first, with pnpm build');

// xcodebuild waits two hours on a locked device before it fails.
if (!sim) {
  const lock = run('xcrun', ['devicectl', 'device', 'info', 'lockState', '--device', udid]);
  if (/passcodeRequired: true/.test(lock)) {
    console.error('PEER CHECK NOT RUN: unlock the device first');
    process.exit(2);
  }
}

const target = sim
  ? ['-destination', process.argv[3] ?? 'platform=iOS Simulator,name=iPad Pro 11-inch (M5),OS=27.2', '-derivedDataPath', 'build', 'CODE_SIGN_STYLE=Manual', 'CODE_SIGN_IDENTITY=-', 'DEVELOPMENT_TEAM=']
  : ['-destination', `id=${udid}`, '-derivedDataPath', 'build-device', '-allowProvisioningUpdates'];
const project = ['-project', 'AgentBrief.xcodeproj', '-scheme', 'AgentBrief'];
console.log('building');
run('xcodebuild', ['build-for-testing', ...project, ...target], { cwd: ios });
if (!sim) run('xcrun', ['devicectl', 'device', 'install', 'app', '--device', udid, join(ios, 'build-device/Build/Products/Debug-iphoneos/AgentBrief.app')]);

// The Mac side listens on loopback alone, so the helper is the one way in and the Mac's usual port stays free.
const stub = spawn('node', ['live/ipad-stub.mjs', '--prompt', prompt, '--loopback'], {
  cwd: companion,
  env: { ...process.env, COMPANION_TEST_PEER: helper, COMPANION_IPAD_NAME: 'Peer Check Mac' },
  stdio: ['ignore', 'pipe', 'inherit'],
});
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

// Only the peer route can answer this link.
const link = new URL(info.pairUrl);
const listenerPort = link.searchParams.get('p');
link.searchParams.set('h', 'stub-gone.invalid,192.0.2.1');
const macName = link.searchParams.get('m');

// nettop names the interface each of the helper's connections uses, including flows that never become sockets.
const helperPid = spawnSync('pgrep', ['-f', `agent-brief-peer --name .* --port ${listenerPort}`], { encoding: 'utf8' }).stdout.trim().split('\n')[0];
if (!helperPid) {
  console.error('PEER CHECK FAILED: the Mac side started no peer helper');
  stub.kill('SIGTERM');
  process.exit(1);
}
const peers = new Set();
let sampling = false;
const watch = setInterval(() => {
  if (sampling) return;
  sampling = true;
  execFile('nettop', ['-L', '1', '-n', '-m', 'tcp', '-p', helperPid], { encoding: 'utf8' }, (_err, text) => {
    sampling = false;
    for (const line of (text ?? '').split('\n')) {
      const [, flow, iface, state] = line.split(',');
      if (!flow?.includes('<->') || state !== 'Established' || iface === 'lo0') continue;
      peers.add(`${iface} (${flow.split('<->')[1]})`);
    }
  });
}, 300);

const result = join(dir, 'run.xcresult');
const test = spawn('xcodebuild', ['test-without-building', ...project, ...target, '-resultBundlePath', result, '-only-testing:AgentBriefUITests/DevicePeerTests'], {
  cwd: ios,
  env: { ...process.env, TEST_RUNNER_AB_PAIR_URL: link.toString(), TEST_RUNNER_AB_PROMPT: prompt, TEST_RUNNER_AB_MAC_NAME: macName },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
const take = (d) => (log = (log + d).slice(-6000));
test.stdout.on('data', take);
test.stderr.on('data', take);
const code = await new Promise((r) => test.on('close', r));
clearInterval(watch);
console.log(code === 0 ? 'xcodebuild test passed' : log);
spawnSync('xcrun', ['xcresulttool', 'export', 'attachments', '--path', result, '--output-path', join(dir, 'shots')], { stdio: 'ignore' });

await new Promise((r) => setTimeout(r, 2000));
const sketches = join(info.project, '.feedback/sketches');
const bundles = existsSync(sketches) ? readdirSync(sketches) : [];
console.log(`bundles: ${bundles.join(', ') || 'none'}`);
console.log(`peers seen by the helper: ${[...peers].join(', ') || 'none'}`);
const manifest = join(dir, 'shots/manifest.json');
if (existsSync(manifest)) {
  for (const entry of JSON.parse(readFileSync(manifest, 'utf8')).flatMap((t) => t.attachments ?? [])) {
    const name = entry.suggestedHumanReadableName ?? '';
    if (/^(peer-seconds|paired-before)/.test(name)) console.log(`${name.replace(/_.*$/, '')}: ${readFileSync(join(dir, 'shots', entry.exportedFileName), 'utf8')}`);
  }
}
const ok = code === 0 && bundles.length > 0 && (sim || peers.size > 0);
console.log(ok ? 'PEER CHECK PASSED' : 'PEER CHECK FAILED');
stub.kill('SIGTERM');
process.exit(ok ? 0 : 1);
