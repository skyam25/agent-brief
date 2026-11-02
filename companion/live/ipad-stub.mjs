#!/usr/bin/env node
/**
 * Runs the real Mac side for an iPad or simulator, with no Claude Code and without touching the installed app.
 * The built app runs off screen with its own data folder and socket. A registered stand-in session
 * takes the deliveries, and each bundle's path prints as it lands.
 *
 *   cd companion && pnpm build && node live/ipad-stub.mjs [--loopback] [--prompt "<text>"] [--no-handoff]
 *
 * --loopback binds 127.0.0.1 on a free port, for the simulator. Otherwise it binds the LAN on the usual port.
 * It prints JSON with the pair URL, the socket and the project folder, also saved to `<tmp>/stub.json`,
 * and a QR code PNG. Pairing makes the first hand-off unless --no-handoff is given.
 * `COMPANION_SOCKET=<socket> agent-brief handoff --session stub-session` makes more. Ctrl-C ends it.
 */

import { _electron as electron } from '@playwright/test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SESSION = 'stub-session';
const REGISTER_MS = 30_000;
const WATCH_MS = 1000;

const argv = process.argv.slice(2);
const loopback = argv.includes('--loopback');
const noHandoff = argv.includes('--no-handoff');
const promptAt = argv.indexOf('--prompt');
const prompt = promptAt >= 0 ? argv[promptAt + 1] : 'Mark this up and talk me through it';

// Short paths keep the Unix socket under the OS path limit.
const tmp = mkdtempSync('/tmp/ipad-stub-');
const dataDir = join(tmp, 'data');
const project = join(tmp, 'project');
const socket = join(tmp, 's.sock');
mkdirSync(project);

function call(method, path, body) {
  return new Promise((ok, fail) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      { socketPath: socket, method, path, headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {} },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => ok({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') }));
      },
    );
    req.on('error', fail);
    req.end(payload);
  });
}

const app = await electron.launch({
  args: [ROOT],
  cwd: ROOT,
  env: {
    ...process.env,
    COMPANION_TEST: '1',
    COMPANION_DATA_DIR: dataDir,
    COMPANION_SOCKET: socket,
    ...(loopback ? { COMPANION_IPAD_HOST: '127.0.0.1', COMPANION_IPAD_PORT: '0' } : {}),
  },
});
const page = await app.firstWindow();
await page.waitForFunction(() => !!window.__board?.api, undefined, { timeout: 30_000 });

const register = () => call('POST', '/sessions', { sessionId: SESSION, cwd: project, title: 'Stub session' });
await register();
setInterval(() => void register(), REGISTER_MS);

const sheet = await app.evaluate(() => globalThis.__companion.ipad.openSheet());
if (!sheet.url) {
  console.error(sheet.error ?? 'no pair URL');
  await app.close();
  process.exit(1);
}

const qr = join(tmp, 'pair-qr.png');
await QRCode.toFile(qr, sheet.url, { errorCorrectionLevel: 'M', margin: 2, width: 512 });
const info = { pairUrl: sheet.url, qr, socket, project, dataDir, session: SESSION };
writeFileSync(join(tmp, 'stub.json'), JSON.stringify(info, null, 2));
console.log(JSON.stringify({ ...info, stub: join(tmp, 'stub.json') }, null, 2));

// The session's bundles land here. A hand-off waits for a paired iPad, since the app refuses one before.
const sketches = join(project, '.feedback', 'sketches');
const seen = new Set();
let handedOff = noHandoff;
setInterval(() => {
  void (async () => {
    if (!handedOff && (await call('GET', '/ipad')).body.paired) {
      handedOff = true;
      const made = await call('POST', '/handoffs', { sessionId: SESSION, prompt });
      console.log(`paired. hand-off ${made.body.id} is in the inbox`);
    }
    let bundles = [];
    try {
      bundles = readdirSync(sketches);
    } catch {
      // No bundle has landed yet.
    }
    for (const id of bundles) {
      if (seen.has(id)) continue;
      seen.add(id);
      const dir = join(sketches, id);
      const timeline = join(dir, 'timeline.md');
      console.log(`delivered: ${dir}`);
      try {
        console.log(readFileSync(timeline, 'utf8'));
      } catch {
        console.log('(no timeline)');
      }
    }
  })().catch((err) => console.error(err.message));
}, WATCH_MS);

const quit = async () => {
  await app.close().catch(() => undefined);
  process.exit(0);
};
process.on('SIGINT', () => void quit());
process.on('SIGTERM', () => void quit());
