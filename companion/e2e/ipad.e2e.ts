import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import https from 'node:https';
import { join } from 'node:path';
import type { TLSSocket } from 'node:tls';
import { parsePairUrl, type IpadDelivery, type PairLink } from '../src/shared/ipad';
import { launch, RESULTS, ROOT, sceneElements, showPanel, sock, tempDataDir } from './helpers';

const NEUTRAL_BOUNDS = { x: 0, y: 0, width: 400, height: 300 };

/** A client that pins the certificate as the iPad does. */
function lan(link: PairLink, method: string, path: string, credential?: string, body?: unknown) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = https.request(
      {
        host: link.hosts[0],
        port: link.port,
        method,
        path,
        agent: false,
        rejectUnauthorized: false,
        headers: { ...(credential ? { Authorization: `Bearer ${credential}` } : {}), ...(payload ? { 'Content-Length': payload.length } : {}) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode ?? 0, body: res.headers['content-type']?.startsWith('application/json') ? JSON.parse(text) : text });
        });
      },
    );
    req.on('error', reject);
    req.on('socket', (s) =>
      s.once('secureConnect', () => {
        const seen = createHash('sha256').update((s as TLSSocket).getPeerCertificate().raw).digest('base64url');
        if (seen !== link.fingerprint) req.destroy(new Error('pin mismatch'));
      }),
    );
    req.end(payload);
  });
}

test('pair iPad: the sheet, a full hand-off through the real Sender, and Forget', async () => {
  const dataDir = tempDataDir();
  const socketPath = join(dataDir, 'companion.sock');
  const { app, page } = await launch(dataDir, { COMPANION_IPAD_HOST: '127.0.0.1', COMPANION_IPAD_PORT: '0' });
  await showPanel(app, page);

  // A session with nothing paired cannot hand off.
  const project = tempDataDir();
  await sock<any>(socketPath, 'POST', '/sessions', { sessionId: 's1', cwd: project });
  const refused = await sock<any>(socketPath, 'POST', '/handoffs', { sessionId: 's1' });
  expect(refused.status).toBe(409);
  expect(refused.body.error).toContain('Pair iPad…');

  await app.evaluate(() => globalThis.__companion.pairIpad());
  const sheet = page.getByTestId('ipad-sheet');
  await expect(sheet).toBeVisible();
  await expect(page.getByTestId('ipad-qr').locator('svg')).toBeVisible();
  await expect(sheet).toContainText('No iPad yet.');
  await page.screenshot({ path: join(RESULTS, 'ipad-sheet.png') });

  const url = await page.getByTestId('ipad-qr').getAttribute('data-url');
  const link = parsePairUrl(url!)!;
  const paired = await lan(link, 'POST', '/v1/pair', undefined, { code: link.code, deviceName: 'Test iPad' });
  expect(paired.status).toBe(200);
  const credential: string = paired.body.credential;

  // The pairing shows in the sheet and spends the code.
  await expect(page.getByTestId('ipad-devices')).toContainText('Test iPad');
  await expect(page.getByTestId('ipad-qr')).toHaveCount(0);
  expect((await sock<any>(socketPath, 'GET', '/sessions')).body.ipadPaired).toBe(true);
  await page.screenshot({ path: join(RESULTS, 'ipad-sheet-paired.png') });

  // Closing the sheet leaves the listener up for the paired iPad.
  await page.getByTestId('ipad-close').click();
  await expect(sheet).toHaveCount(0);
  expect((await lan(link, 'GET', '/v1/handoffs', credential)).status).toBe(200);

  const made = await sock<any>(socketPath, 'POST', '/handoffs', { sessionId: 's1', prompt: 'Mark up the flow' });
  expect(made.status).toBe(200);
  expect((await lan(link, 'GET', '/v1/handoffs', credential)).body.handoffs[0]).toMatchObject({ id: made.body.id, prompt: 'Mark up the flow' });

  const png = await app.evaluate(() => globalThis.__companion.backend.png('current', {}).then((b) => b.toString('base64')));
  const delivery: IpadDelivery = {
    pngBase64: png,
    scene: { type: 'excalidraw', version: 2, elements: [], appState: {}, files: {} },
    notes: 'from the couch',
    strokes: [{ t: 0, tEnd: 300, elementId: 'e1', type: 'freedraw', bbox: { x: 20, y: 20, width: 80, height: 40 }, by: 'user', kind: 'add' }],
    utterances: [{ t: 100, tEnd: 1500, text: 'this step is wrong' }],
    bounds: NEUTRAL_BOUNDS,
  };
  const sent = await lan(link, 'POST', `/v1/handoffs/${made.body.id}/deliver`, credential, delivery);
  expect(sent.status).toBe(200);
  expect(sent.body.state).toBe('delivered');

  // A retry writes nothing new.
  await lan(link, 'POST', `/v1/handoffs/${made.body.id}/deliver`, credential, delivery);
  const sketches = join(project, '.feedback', 'sketches');
  expect(readdirSync(sketches)).toHaveLength(1);
  const bundle = join(sketches, readdirSync(sketches)[0]);
  const timeline = readFileSync(join(bundle, 'timeline.md'), 'utf8');
  expect(timeline).toContain('this step is wrong');
  expect(timeline).not.toContain('## Audio');

  // The session gets it, and the board lists under it.
  const deliveries = await sock<any>(socketPath, 'GET', '/deliveries?session=s1&wait=0');
  expect(deliveries.body.deliveries).toHaveLength(1);
  const boards = await sock<any>(socketPath, 'GET', '/boards');
  expect(boards.body.boards.find((b: { name: string }) => b.name === made.body.boardName)).toMatchObject({ sessionId: 's1' });

  // An ended session never sends elsewhere: the answer files under it.
  const late = await sock<any>(socketPath, 'POST', '/handoffs', { sessionId: 's1' });
  await sock<any>(socketPath, 'DELETE', '/sessions/s1');
  const filed = await lan(link, 'POST', `/v1/handoffs/${late.body.id}/deliver`, credential, delivery);
  expect(filed.body.state).toBe('filed');
  expect(readdirSync(sketches)).toHaveLength(1);

  // Forget ends the pairing.
  await app.evaluate(() => globalThis.__companion.pairIpad());
  const device = (await sock<any>(socketPath, 'GET', '/ipad')).body.devices[0];
  await page.getByTestId(`ipad-forget-${device.id}`).click();
  await expect(sheet).toContainText('No iPad yet.');
  expect((await lan(link, 'GET', '/v1/handoffs', credential)).status).toBe(401);
  await app.close();
});

test('the pair sheet names the peer route while the helper runs, and quitting ends the helper', async () => {
  const dataDir = tempDataDir();
  const peerLog = join(dataDir, 'peer.jsonl');
  const { app, page } = await launch(dataDir, {
    COMPANION_IPAD_HOST: '127.0.0.1',
    COMPANION_IPAD_PORT: '0',
    COMPANION_TEST_PEER: join(ROOT, 'e2e/fixtures/fake-peer.mjs'),
    FAKE_PEER_LOG: peerLog,
  });
  await showPanel(app, page);
  await app.evaluate(() => globalThis.__companion.pairIpad());
  await expect(page.getByTestId('ipad-qr').locator('svg')).toBeVisible();
  await expect(page.getByTestId('ipad-peer')).toContainText('Wi-Fi and Bluetooth');
  await page.screenshot({ path: join(RESULTS, 'ipad-sheet-peer.png') });

  const link = parsePairUrl((await page.getByTestId('ipad-qr').getAttribute('data-url'))!)!;
  const launched = JSON.parse(readFileSync(peerLog, 'utf8').trim().split('\n')[0]!);
  expect(launched.args).toEqual(['--name', `ab-${link.fingerprint.slice(0, 16)}`, '--port', String(link.port)]);
  await app.close();
  await expect.poll(() => {
    try {
      process.kill(launched.pid, 0);
      return true;
    } catch {
      return false;
    }
  }).toBe(false);
});

test('the panel hands the open board to the iPad, and the answer belongs to the session picked', async () => {
  const dataDir = tempDataDir();
  const socketPath = join(dataDir, 'companion.sock');
  const { app, page } = await launch(dataDir, { COMPANION_IPAD_HOST: '127.0.0.1', COMPANION_IPAD_PORT: '0' });
  await showPanel(app, page);
  const button = page.getByTestId('ipad-handoff');
  const chooser = page.getByTestId('send-chooser');
  await sock(socketPath, 'POST', '/sessions', { sessionId: 's1', cwd: tempDataDir() });
  await sock(socketPath, 'POST', '/boards/current/draw', { elements: [{ type: 'text', label: 'from the Mac', x: 0, y: 0 }] });

  // No button until an iPad is paired.
  await expect(button).toHaveCount(0);
  await app.evaluate(() => globalThis.__companion.pairIpad());
  const link = parsePairUrl((await page.getByTestId('ipad-qr').getAttribute('data-url'))!)!;
  const paired = await lan(link, 'POST', '/v1/pair', undefined, { code: link.code, deviceName: 'Test iPad' });
  const credential: string = paired.body.credential;
  await page.getByTestId('ipad-close').click();
  await expect(button).toBeVisible();

  // With no target, it asks for a session and offers nothing but running ones. It never guesses.
  await button.click();
  await expect(chooser).toBeVisible();
  await expect(page.getByTestId('ipad-pick-hint')).toBeVisible();
  await expect(page.getByTestId('new-folder')).toHaveCount(0);
  await page.screenshot({ path: join(RESULTS, 'ipad-handoff-chooser.png') });
  expect((await sock<any>(socketPath, 'GET', '/handoffs')).body.handoffs).toHaveLength(0);

  // A second press closes the chooser, and Send's chooser keeps its other options.
  await button.click();
  await expect(chooser).toHaveCount(0);
  await page.getByTestId('send').click();
  await expect(page.getByTestId('new-folder')).toBeVisible();
  await expect(page.getByTestId('ipad-pick-hint')).toHaveCount(0);
  await page.getByTestId('send').click();
  await expect(chooser).toHaveCount(0);

  await button.click();
  await page.getByTestId('send-to-session').click();
  await expect(chooser).toHaveCount(0);
  await expect(page.getByText('Sent to your iPad.')).toBeVisible();
  await page.screenshot({ path: join(RESULTS, 'ipad-handoff-sent.png') });
  const first = (await sock<any>(socketPath, 'GET', '/handoffs?sessionId=s1')).body.handoffs;
  expect(first).toHaveLength(1);

  // The iPad gets a copy of the board.
  const detail = await lan(link, 'GET', `/v1/handoffs/${first[0].id}`, credential);
  expect(JSON.stringify(detail.body.scene)).toContain('from the Mac');

  // The pick is now the target, so the next press goes straight there.
  await button.click();
  await expect(chooser).toHaveCount(0);
  await expect.poll(async () => (await sock<any>(socketPath, 'GET', '/handoffs?sessionId=s1')).body.handoffs.length).toBe(2);

  // Only a board goes this way, and Forget takes the button away.
  await page.getByTestId('mode-write').click();
  await expect(button).toHaveCount(0);
  await page.getByTestId('mode-sketch').click();
  await expect(button).toBeVisible();
  await app.evaluate(() => globalThis.__companion.pairIpad());
  const device = (await sock<any>(socketPath, 'GET', '/ipad')).body.devices[0];
  await page.getByTestId(`ipad-forget-${device.id}`).click();
  await page.getByTestId('ipad-close').click();
  await expect(button).toHaveCount(0);
  await app.close();
});

test('in Review, the panel hands the open page to the iPad, which loads it with the overlay and sends back review.md', async () => {
  const dataDir = tempDataDir();
  const socketPath = join(dataDir, 'companion.sock');
  const { app, page } = await launch(dataDir, { COMPANION_IPAD_HOST: '127.0.0.1', COMPANION_IPAD_PORT: '0' });
  await showPanel(app, page);
  const cwd = mkdtempSync(join(tmpdir(), 'project-'));
  mkdirSync(join(cwd, 'site'));
  mkdirSync(join(cwd, '.feedback/outputs'), { recursive: true });
  writeFileSync(join(cwd, 'site/index.html'), '<!doctype html><html><head><title>Landing</title></head><body><h1>Acme analytics</h1></body></html>');
  const now = Date.now();
  const output = { ref: 'site/index.html', title: 'Landing page', kind: 'html', tier: 'declared', status: 'ready', origin: 'created', declaredAt: now, firstWriteAt: now, lastWriteAt: now, writes: 1 };
  writeFileSync(join(cwd, '.feedback/outputs/s1.json'), JSON.stringify({ version: 1, sessionId: 's1', outputs: [output] }));
  await sock(socketPath, 'POST', '/sessions', { sessionId: 's1', cwd, title: 'Landing' });

  await app.evaluate(() => globalThis.__companion.pairIpad());
  const link = parsePairUrl((await page.getByTestId('ipad-qr').getAttribute('data-url'))!)!;
  const credential: string = (await lan(link, 'POST', '/v1/pair', undefined, { code: link.code, deviceName: 'Test iPad' })).body.credential;
  await page.getByTestId('ipad-close').click();

  await sock(socketPath, 'POST', '/open', { sessionId: 's1' });
  await page.getByTestId('mode-review').click();
  await expect(page.getByTestId('review')).toBeVisible();
  const button = page.getByTestId('ipad-handoff');
  await expect(button).toBeVisible();
  await button.click();
  if (await page.getByTestId('send-chooser').isVisible()) await page.getByTestId('send-to-session').click();
  await expect(page.getByText('Sent the page to your iPad.')).toBeVisible();

  const [handoff] = (await sock<any>(socketPath, 'GET', '/handoffs?sessionId=s1')).body.handoffs;
  expect(handoff).toMatchObject({ page: 'site/index.html' });
  const served = await lan(link, 'GET', `/v1/handoffs/${handoff.id}/page/site/index.html`, credential);
  expect(served.status).toBe(200);
  expect(served.body).toContain('<script src="/__agent-brief__/overlay.js"></script>');

  // The iPad's review reaches the session as review.md, through the same Send a Mac review uses.
  const anchor = { selector: 'body > h1', tag: 'h1', text: 'Acme analytics', fx: 0.5, fy: 0.5, rect: { x: 0, y: 0, width: 300, height: 40 }, scrollY: 0, viewport: { width: 400, height: 800 } };
  const reply = await lan(link, 'POST', `/v1/handoffs/${handoff.id}/deliver`, credential, { review: { comments: [{ id: 'c1', text: 'Name the product', createdAt: now, anchor }], body: '' }, utterances: [] });
  expect(reply.body).toMatchObject({ ok: true, state: 'delivered' });
  const sketches = join(cwd, '.feedback/sketches');
  await expect.poll(() => readdirSync(sketches).length).toBe(1);
  const reviewMd = readFileSync(join(sketches, readdirSync(sketches)[0]!, 'review.md'), 'utf8');
  expect(reviewMd).toContain('# Review of site/index.html');
  expect(reviewMd).toContain('Name the product');
  await app.close();
});

test("the iPad's Send updates the board it started from, or keeps both when the Mac changed it", async () => {
  const dataDir = tempDataDir();
  const socketPath = join(dataDir, 'companion.sock');
  const { app, page } = await launch(dataDir, { COMPANION_IPAD_HOST: '127.0.0.1', COMPANION_IPAD_PORT: '0' });
  await showPanel(app, page);
  await sock(socketPath, 'POST', '/sessions', { sessionId: 's1', cwd: tempDataDir() });
  await sock(socketPath, 'POST', '/boards/current/draw', { elements: [{ type: 'text', label: 'from the Mac', x: 0, y: 0 }] });
  await app.evaluate(() => globalThis.__companion.pairIpad());
  const link = parsePairUrl((await page.getByTestId('ipad-qr').getAttribute('data-url'))!)!;
  const credential: string = (await lan(link, 'POST', '/v1/pair', undefined, { code: link.code, deviceName: 'Test iPad' })).body.credential;
  await page.getByTestId('ipad-close').click();
  const texts = () => sceneElements(page).then((els: readonly any[]) => els.filter((e) => !e.isDeleted && e.type === 'text').map((e) => e.text));
  const boardNames = async () => (await sock<any>(socketPath, 'GET', '/boards')).body.boards.map((b: { name: string }) => b.name);
  const current: string = (await sock<any>(socketPath, 'GET', '/boards')).body.current;
  await expect.poll(texts).toEqual(['from the Mac']);

  /** Hands off the open board and answers with what the iPad drew on its copy. */
  const handOffAndDraw = async (before: () => Promise<unknown> = async () => {}) => {
    const made = (await sock<any>(socketPath, 'POST', '/handoffs', { sessionId: 's1', board: current })).body;
    const base = (await lan(link, 'GET', `/v1/handoffs/${made.id}`, credential)).body.scene;
    const scene = typeof base === 'string' ? JSON.parse(base) : base;
    const added = { ...scene.elements[0], id: `ipad-${made.id}`, text: `from the iPad ${made.id}`, originalText: `from the iPad ${made.id}`, y: 200, version: 1 };
    await before();
    const delivery: IpadDelivery = { pngBase64: Buffer.from('x').toString('base64'), scene: { ...scene, elements: [...scene.elements, added] }, notes: '', strokes: [], utterances: [], bounds: NEUTRAL_BOUNDS };
    const png = await app.evaluate(() => globalThis.__companion.backend.png('current', {}).then((b) => b.toString('base64')));
    return { made, reply: await lan(link, 'POST', `/v1/handoffs/${made.id}/deliver`, credential, { ...delivery, pngBase64: png }) };
  };

  // Nothing changed on the Mac: the open board shows the iPad's work, and no new board appears.
  const first = await handOffAndDraw();
  expect(first.reply.body.state).toBe('delivered');
  await expect.poll(texts).toEqual(['from the Mac', `from the iPad ${first.made.id}`]);
  expect(await boardNames()).not.toContain(first.made.boardName);
  await page.screenshot({ path: join(RESULTS, 'ipad-board-updated.png') });

  // The delivery names the board the user knows.
  const delivered = (await sock<any>(socketPath, 'GET', '/deliveries?session=s1&wait=0')).body.deliveries;
  expect(delivered.at(-1).prompt ?? JSON.stringify(delivered.at(-1))).toContain(current);

  // An edit on the Mac stays, and the iPad's work becomes its own board.
  const second = await handOffAndDraw(() => sock(socketPath, 'POST', '/boards/current/draw', { elements: [{ type: 'text', label: 'edited on the Mac', x: 0, y: 400 }] }));
  expect(second.reply.body.message).toContain('changed on the Mac');
  expect(await texts()).toContain('edited on the Mac');
  expect(await texts()).not.toContain(`from the iPad ${second.made.id}`);
  await expect.poll(boardNames).toContain(second.made.boardName);
  expect((await sock<any>(socketPath, 'GET', '/boards')).body.current).toBe(current);

  // A blank hand-off opens its new board only when the panel is on that session.
  const blank = (await sock<any>(socketPath, 'POST', '/handoffs', { sessionId: 's1' })).body;
  const blankScene = { type: 'excalidraw', version: 2, elements: [], appState: {}, files: {} };
  const png = await app.evaluate(() => globalThis.__companion.backend.png('current', {}).then((b) => b.toString('base64')));
  await lan(link, 'POST', `/v1/handoffs/${blank.id}/deliver`, credential, { pngBase64: png, scene: blankScene, notes: '', strokes: [], utterances: [], bounds: NEUTRAL_BOUNDS });
  await expect.poll(boardNames).toContain(blank.boardName);
  expect((await sock<any>(socketPath, 'GET', '/boards')).body.current).toBe(current);

  await sock(socketPath, 'POST', '/open', { sessionId: 's1' });
  const shown = (await sock<any>(socketPath, 'POST', '/handoffs', { sessionId: 's1' })).body;
  await lan(link, 'POST', `/v1/handoffs/${shown.id}/deliver`, credential, { pngBase64: png, scene: blankScene, notes: '', strokes: [], utterances: [], bounds: NEUTRAL_BOUNDS });
  await expect.poll(async () => (await sock<any>(socketPath, 'GET', '/boards')).body.current).toBe(shown.boardName);
  await app.close();
});

test("the iPad's comments reach the session as comments.md", async () => {
  const dataDir = tempDataDir();
  const socketPath = join(dataDir, 'companion.sock');
  const { app, page } = await launch(dataDir, { COMPANION_IPAD_HOST: '127.0.0.1', COMPANION_IPAD_PORT: '0' });
  await showPanel(app, page);
  const project = tempDataDir();
  await sock(socketPath, 'POST', '/sessions', { sessionId: 's1', cwd: project });
  await app.evaluate(() => globalThis.__companion.pairIpad());
  const link = parsePairUrl((await page.getByTestId('ipad-qr').getAttribute('data-url'))!)!;
  const credential: string = (await lan(link, 'POST', '/v1/pair', undefined, { code: link.code, deviceName: 'Test iPad' })).body.credential;
  const made = (await sock<any>(socketPath, 'POST', '/handoffs', { sessionId: 's1' })).body;
  const png = await app.evaluate(() => globalThis.__companion.backend.png('current', {}).then((b) => b.toString('base64')));
  const comments = { overall: 'Tighten this flow', pins: [{ id: 'p1', x: 10, y: 10, type: 'rectangle', text: 'Make this bigger', createdAt: 1 }] };
  const sent = await lan(link, 'POST', `/v1/handoffs/${made.id}/deliver`, credential, { pngBase64: png, scene: { type: 'excalidraw', version: 2, elements: [], appState: {}, files: {} }, notes: '', strokes: [], utterances: [], bounds: NEUTRAL_BOUNDS, comments });
  expect(sent.status).toBe(200);
  const sketches = join(project, '.feedback', 'sketches');
  const written = readFileSync(join(sketches, readdirSync(sketches)[0], 'comments.md'), 'utf8');
  expect(written).toContain('Make this bigger');
  expect(written).toContain('Tighten this flow');
  await app.close();
});
