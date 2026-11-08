// End-to-end check on a simulator: the XCUITest pairs, draws, talks, notes and sends, and this asserts what the stub received.
// Run from companion/: node ios/test/run-sim.mjs
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStub } from './stub-server.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ios = join(here, '..');
const dir = join(here, '.run');
const simulator = process.env.AB_SIM ?? 'platform=iOS Simulator,name=iPad Pro 11-inch (M5),OS=27.2';

rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

const audio = join(dir, 'speech.wav');
const phrases = 'Circle the sign up button|This step needs a clearer error';
const sayText = 'Circle the sign up button. This step needs a clearer error.';
spawnSync('say', ['-o', audio, '--data-format=LEI16@16000', sayText]);

const useCanned = process.env.AB_CANNED !== '0';

// AB_ONLY narrows the run to a comma-separated list of tests, such as HandoffFlowTests/testTwoMacsKeepTheirOwnHandoffs. The checks below then report what those tests skipped.
const allTests = ['CommentFlowTests', 'StackHandoffTests', 'BoardToolsTests', 'PageHandoffTests', 'HandoffFlowTests/testPairDrawTalkNoteSend', 'HandoffFlowTests/testSendWaitsSurvivesKillThenLands', 'HandoffFlowTests/testTwoMacsKeepTheirOwnHandoffs', 'HandoffFlowTests/testWrongFingerprintRefusedThenDeepLinkPairsThenRevokeUnpairs'];
const onlyTesting = (process.env.AB_ONLY?.split(',') ?? allTests).map((t) => `-only-testing:AgentBriefUITests/${t}`);
const stub = await startStub({ dir });
const stubA = await startStub({ dir: join(dir, 'mac-a'), macName: 'First Stub Mac', promptPrefix: 'First Mac: ' });
const stubB = await startStub({ dir: join(dir, 'mac-b'), macName: 'Second Stub Mac', promptPrefix: 'Second Mac: ' });
const stubC = await startStub({ dir: join(dir, 'mac-c'), macName: 'Comment Stub Mac' });
const stubS = await startStub({ dir: join(dir, 'mac-s'), macName: 'Stack Stub Mac', stack: true, link: true, page: true });
console.log(`stub on ${stub.port}, fingerprint ${stub.fingerprint}`);

const env = {
  ...process.env,
  TEST_RUNNER_AB_PAIR_URL: stub.pairUrl,
  TEST_RUNNER_AB_PAIR_URL_A: stubA.pairUrl,
  TEST_RUNNER_AB_PAIR_URL_B: stubB.pairUrl,
  TEST_RUNNER_AB_PAIR_URL_C: stubC.pairUrl,
  TEST_RUNNER_AB_PAIR_URL_S: stubS.pairUrl,
  TEST_RUNNER_AB_STUB_DIR: dir,
  TEST_RUNNER_AB_TALK_SECONDS: process.env.AB_TALK_SECONDS ?? (useCanned ? '3' : '8'),
  ...(useCanned ? { TEST_RUNNER_AB_TEST_PHRASES: phrases } : { TEST_RUNNER_AB_TEST_AUDIO: audio }),
};
const result = await new Promise((resolve) => {
  import('node:child_process').then(({ spawn }) => {
    const child = spawn(
      'xcodebuild',
      ['test', '-project', 'AgentBrief.xcodeproj', '-scheme', 'AgentBrief', '-destination', simulator, '-derivedDataPath', 'build', '-parallel-testing-enabled', 'NO', ...onlyTesting, 'CODE_SIGN_STYLE=Manual', 'CODE_SIGN_IDENTITY=-', 'DEVELOPMENT_TEAM='],
      { cwd: ios, env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let tail = '';
    const take = (d) => {
      appendFileSync(join(dir, 'xcodebuild.log'), d);
      tail = (tail + d).slice(-3000);
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('close', (code) => resolve({ code, tail }));
  });
});
stub.server.close();
stub.server.closeAllConnections();
for (const other of [stubA, stubB, stubC, stubS]) {
  other.server.close();
  other.server.closeAllConnections();
}

const fail = [];
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) fail.push(what);
};
if (result.code !== 0) console.log(result.tail);
check(result.code === 0, 'xcodebuild test passed');

const paired = stub.received.find((r) => r.kind === 'pair');
check(Boolean(paired?.deviceName), `paired with device name ${paired?.deviceName}`);

const first = stub.received.find((r) => r.kind === 'deliver' && r.id === 'h1')?.payload;
check(Boolean(first), 'h1 delivered');
if (first) {
  const png = Buffer.from(first.pngBase64, 'base64');
  check(png.subarray(1, 4).toString() === 'PNG' && png.length > 1000, `PNG arrived, ${png.length} bytes`);
  const elements = first.scene.elements.filter((e) => !e.isDeleted);
  check(elements.some((e) => e.id === 'base1'), 'the Mac board came back with its rectangle');
  check(elements.filter((e) => e.type === 'freedraw').length >= 2, `drawn strokes are in the scene (${elements.filter((e) => e.type === 'freedraw').length})`);
  const userStrokes = first.strokes.filter((s) => s.by === 'user' && s.kind === 'add');
  check(userStrokes.length >= 2, `stroke events ${userStrokes.length}`);
  check(first.notes === 'Check the second step', `note is ${JSON.stringify(first.notes)}`);
  check(first.utterances.length >= 1, `utterances: ${JSON.stringify(first.utterances)}`);
  const said = first.utterances.map((u) => u.text).join(' ').toLowerCase();
  check(said.includes('sign') && said.includes('error'), `speech text matches: ${said}`);
  const starts = [...first.strokes.map((s) => s.t), ...first.utterances.map((u) => u.t)];
  check(Math.min(...starts) === 0, 'the earliest stroke or phrase is at 0');
  const lastStroke = Math.max(...first.strokes.map((s) => s.t));
  const firstSpeech = Math.min(...first.utterances.map((u) => u.t));
  check(Math.abs(lastStroke - firstSpeech) < 60_000, `strokes and speech share one clock (stroke at ${lastStroke} ms, speech at ${firstSpeech} ms)`);
  check(first.bounds.width > 0, 'bounds cover the drawing');
}
const second = stub.received.find((r) => r.kind === 'deliver' && r.id === 'h2')?.payload;
check(Boolean(second), 'h2 delivered after a kill and a relaunch');
check(stub.received.filter((r) => r.kind === 'deliver' && r.id === 'h2').length === 1, 'the retry wrote one delivery');

const toB = stubB.received.filter((r) => r.kind === 'deliver');
check(toB.length === 1 && toB[0].id === 'h1', 'the second Mac got exactly its own hand-off');
check(!stubA.received.some((r) => r.kind === 'deliver'), 'a Send to the second Mac never reached the first');
check(!stubA.received.some((r) => r.kind === 'unpair'), 'forgetting the second Mac left the first alone');
check(stubB.received.some((r) => r.kind === 'unpair'), 'forgetting a Mac told it');
check(Boolean(paired?.installId), 'pairing sent an install id');

const commented = stubC.received.find((r) => r.kind === 'deliver')?.payload;
check(Boolean(commented), 'a board with comments delivered');
const pins = commented?.comments?.pins ?? [];
check(pins.length === 1 && pins[0].text.includes('Make this bigger'), `the pin arrived after a relaunch: ${JSON.stringify(pins.map((p) => p.text))}`);
check(pins[0]?.text.includes('Circle'), 'words said on a selected pin landed on it');
check((commented?.utterances ?? []).length === 0, `words said on a pin stay out of the timeline: ${JSON.stringify(commented?.utterances)}`);

const reviewed = stubS.received.find((r) => r.kind === 'deliver' && r.id === 'hp')?.payload;
check(Boolean(reviewed?.review), 'the page hand-off delivered a review');
const pagePins = reviewed?.review?.comments ?? [];
check(pagePins.length === 1 && pagePins[0].anchor?.tag === 'h1', `the page comment sits on the heading: ${JSON.stringify(pagePins.map((c) => c.anchor?.tag))}`);
check(pagePins[0]?.text.includes('Shorter title'), `the page comment kept its words: ${JSON.stringify(pagePins[0]?.text)}`);
check(!('pngBase64' in (reviewed ?? {})), 'a page review carries no sketch');

console.log(fail.length ? `\n${fail.length} failed` : '\nall passed');
console.log(`screenshots and deliveries in ${dir}`);
process.exit(fail.length ? 1 : 0);
