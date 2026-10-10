import { expect, test } from '@playwright/test';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { DeliveriesResponse } from '../src/protocol';
import { backend, launch, type Launched, openNotes, RESULTS, ROOT, sceneElements, sendToSession, showPanel, sock, tempDataDir } from './helpers';

const run = promisify(execFile);

let ctx: Launched;
let socketPath: string;
let dataDir: string;

test.beforeEach(async () => {
  dataDir = tempDataDir();
  socketPath = join(dataDir, 'companion.sock');
  ctx = await launch(dataDir);
  await showPanel(ctx.app, ctx.page);
  await expect.poll(() => existsSync(socketPath)).toBe(true);
});

test.afterEach(async () => {
  await ctx.app.close();
});

const project = () => mkdtempSync(join(tmpdir(), 'project-'));
const panelVisible = () => ctx.app.evaluate(() => (globalThis as any).__companion.panel.isVisible());

const bundles = (cwd: string) => {
  const dir = join(cwd, '.feedback', 'sketches');
  return existsSync(dir) ? readdirSync(dir) : [];
};

test('C2.4 the socket file is owner-only (0600)', async () => {
  expect(statSync(socketPath).mode & 0o777).toBe(0o600);
  const health = await sock(socketPath, 'GET', '/health');
  expect(health.body).toMatchObject({ ok: true, panelVisible: true, currentBoard: 'scratch' });
});

test('opened standalone, Send asks where to go and never picks a session itself', async () => {
  const { page } = ctx;
  await expect(page.getByTestId('send')).toHaveText('Send to…');
  await page.getByTestId('send').click();
  await expect(page.getByTestId('send-chooser')).toContainText('No Claude Code session has the companion open');

  // A session that registers is listed but not chosen.
  await sock(socketPath, 'POST', '/sessions', { sessionId: 's1', cwd: project(), title: 'Login work', summary: 'tighten the header' });
  await expect(page.getByTestId('send-to-session')).toHaveText(/Login work.*tighten the header/);
  await page.screenshot({ path: join(RESULTS, 'send-chooser.png') });
  expect((await sock(socketPath, 'GET', '/sessions')).body.targetSessionId).toBeUndefined();
  await expect(page.getByTestId('target-chip')).toHaveCount(0);
  expect(await panelVisible()).toBe(true);
});

test('the notes pane starts collapsed', async () => {
  await expect(ctx.page.getByTestId('notes-toggle')).toHaveAttribute('aria-pressed', 'false');
  await expect(ctx.page.getByTestId('notes')).toHaveCount(0);
});

test('C2.2 Send writes the bundle into the project and queues the delivery', async () => {
  const { app, page } = ctx;
  const cwd = project();
  await sock(socketPath, 'POST', '/sessions', { sessionId: 's1', cwd, title: 'Login work' });

  await backend(app, 'draw', 'current', { elements: [{ type: 'sticky', x: 0, y: 0, label: 'Ship it' }] });
  await openNotes(page);
  await page.getByTestId('notes').fill('the header is too tall');
  await sendToSession(page, 'Login work');
  await expect(page.getByTestId('send-status')).toHaveText('Sent to Login work');
  await expect.poll(panelVisible).toBe(false);

  const [id] = bundles(cwd);
  expect(id).toMatch(/^\d{4}-\d{2}-\d{2}-\d{6}/);
  const dir = join(cwd, '.feedback', 'sketches', id);
  expect(readdirSync(dir).sort()).toEqual(['board.excalidraw', 'notes.md', 'sketch.png', 'timeline.md']);
  expect(readFileSync(join(dir, 'timeline.md'), 'utf8')).toMatch(/Claude drew .*sticky "Ship it"/);
  expect(readFileSync(join(dir, 'sketch.png')).subarray(1, 4).toString()).toBe('PNG');
  expect(readFileSync(join(dir, 'notes.md'), 'utf8')).toBe('the header is too tall');
  const scene = JSON.parse(readFileSync(join(dir, 'board.excalidraw'), 'utf8'));
  expect(scene.elements.some((e: any) => e.customData?.by === 'claude')).toBe(true);

  const polled = await sock<DeliveriesResponse>(socketPath, 'GET', '/deliveries?session=s1&wait=0');
  expect(polled.body.deliveries).toHaveLength(1);
  const d = polled.body.deliveries[0];
  expect(d).toMatchObject({ id, sessionId: 's1', dir, mode: 'submit' });
  expect(d.draft).toContain(`@.feedback/sketches/${id}/sketch.png`);
  expect(d.draft).toContain('Notes: the header is too tall');

  // The next sketch starts blank; History brings the sent one back with its notes.
  await showPanel(app, page);
  expect((await sceneElements(page)).filter((e) => !e.isDeleted)).toHaveLength(0);
  await openNotes(page);
  await expect(page.getByTestId('notes')).toHaveValue('');
  await page.getByTestId('history-toggle').click();
  await page.getByTestId('history-open').first().click();
  await expect(page.getByTestId('notes')).toHaveValue('the header is too tall');
  expect((await sceneElements(page)).filter((e) => !e.isDeleted).length).toBeGreaterThan(0);
});

test('the history keeps the last 10 sends and opens one on a new board', async () => {
  const { app, page } = ctx;
  const cwd = project();
  await sock(socketPath, 'POST', '/sessions', { sessionId: 's1', cwd, title: 'Login work' });

  for (let n = 1; n <= 11; n++) {
    await backend(app, 'draw', 'current', { elements: [{ type: 'sticky', id: `n${n}`, x: n * 10, y: 0, label: `Send ${n}` }] });
    await showPanel(app, page);
    await sendToSession(page, 'Login work');
    await expect.poll(panelVisible).toBe(false);
  }

  const history = await app.evaluate(() => (globalThis as any).__companion.history.list());
  expect(history).toHaveLength(10);
  expect(history[0]).toMatchObject({ board: 'scratch', target: 'Login work' });
  expect(history[0].draft).toContain(`@.feedback/sketches/${history[0].id}/sketch.png`);
  expect(readdirSync(join(dataDir, 'history')).filter((f) => f !== 'index.json')).toHaveLength(10);
  // Project bundles are Claude's record and stay put.
  expect(bundles(cwd)).toHaveLength(11);

  await showPanel(app, page);
  await page.getByTestId('history-toggle').click();
  await expect(page.getByTestId('history-item')).toHaveCount(10);
  await expect(page.getByTestId('history-item').first().locator('img')).toBeVisible();
  await page.screenshot({ path: join(RESULTS, 'history.png') });
  await page.getByTestId('history-item').last().getByTestId('history-open').click();
  await expect(page.getByTestId('board-picker')).toHaveValue(/^scratch \d{2}\.\d{2}$/);
  const restored = await page.evaluate(() =>
    (window as any).__excalidraw.getSceneElements().filter((e: any) => e.type === 'text').map((e: any) => e.text),
  );
  // The oldest kept send is the second one.
  expect(restored).toContain('Send 2');
  expect(restored).not.toContain('Send 3');
});

test('C2.3 with two sessions the delivery reaches only the picked one', async () => {
  const { page } = ctx;
  const a = project();
  const b = project();
  await sock(socketPath, 'POST', '/sessions', { sessionId: 'sa', cwd: a, title: 'Alpha' });
  await sock(socketPath, 'POST', '/sessions', { sessionId: 'sb', cwd: b });
  await page.getByTestId('send').click();
  await expect(page.getByTestId('send-to-session')).toHaveCount(2);
  await page.getByTestId('send-to-session').filter({ hasText: b.split('/').pop()! }).click();
  await expect(page.getByTestId('send-status')).toHaveText(`Sent to ${b.split('/').pop()}`);
  expect(bundles(a)).toEqual([]);
  expect(bundles(b)).toHaveLength(1);
  expect((await sock(socketPath, 'GET', '/deliveries?session=sa&wait=0')).body.deliveries).toEqual([]);
  expect((await sock(socketPath, 'GET', '/deliveries?session=sb&wait=0')).body.deliveries).toHaveLength(1);
});

test('POST /open shows the board and the prompt and picks the session', async () => {
  const { app, page } = ctx;
  await app.evaluate(() => (globalThis as any).__companion.panel.hide());
  const cwd = project();
  await sock(socketPath, 'POST', '/sessions', { sessionId: 's1', cwd });
  await sock(socketPath, 'POST', '/sessions', { sessionId: 's2', cwd });
  const opened = await sock(socketPath, 'POST', '/open', { board: 'login', prompt: 'Sketch the login screen', sessionId: 's2' });
  expect(opened.body).toEqual({ board: 'login', targetSessionId: 's2' });
  await expect(page.getByTestId('board-picker')).toHaveValue('login');
  await expect(page.getByTestId('prompt')).toHaveText(/Sketch the login screen/);
  await expect(page.getByTestId('target-chip')).toContainText(`→ ${cwd.split('/').pop()}`);
  await expect(page.getByTestId('send')).toHaveText('Send');
  expect(await app.evaluate(() => (globalThis as any).__companion.panel.isVisible())).toBe(true);
});

test('a session opened by /sketch keeps its chip until it leaves; a standalone open starts with none', async () => {
  const { app, page } = ctx;
  const cwd = project();
  await sock(socketPath, 'POST', '/sessions', { sessionId: 's1', cwd, title: 'Login work', host: { terminal: 'ghostty', bundleId: 'com.mitchellh.ghostty' } });
  await sock(socketPath, 'POST', '/open', { sessionId: 's1' });
  await expect(page.getByTestId('target-chip')).toContainText('→ Login work · Ghostty');
  await page.screenshot({ path: join(RESULTS, 'send-chip.png'), clip: { x: 0, y: 0, width: 1100, height: 120 } });

  // The chip brings the terminal forward.
  await page.getByTestId('target-chip').click();
  await expect.poll(() => app.evaluate(() => (globalThis as any).__companion.launches.map((l: any) => l.args.join(' ')).join('\n'))).toContain(
    `working directory is "${cwd}"`,
  );

  // The session leaving clears the target; Send asks again.
  await sock(socketPath, 'DELETE', '/sessions/s1');
  await expect(page.getByTestId('target-chip')).toHaveCount(0);
  await expect(page.getByTestId('send')).toHaveText('Send to…');

  // Hiding and showing from the hotkey drops a target /sketch set.
  await sock(socketPath, 'POST', '/sessions', { sessionId: 's2', cwd });
  await sock(socketPath, 'POST', '/open', { sessionId: 's2' });
  await expect(page.getByTestId('target-chip')).toBeVisible();
  await app.evaluate(() => (globalThis as any).__companion.toggle());
  await showPanel(app, page);
  await expect(page.getByTestId('target-chip')).toHaveCount(0);
  expect((await sock(socketPath, 'GET', '/sessions')).body.targetSessionId).toBeUndefined();
});

test('Send to a new session writes the bundle into the folder and starts Claude Code there', async () => {
  const { app, page } = ctx;
  const cwd = project();
  await app.evaluate((_e, cwd) => (globalThis as any).__companion.state.update({ recentProjects: [cwd] }), cwd);
  await backend(app, 'draw', 'current', { elements: [{ type: 'sticky', x: 0, y: 0, label: 'New idea' }] });

  await page.getByTestId('send').click();
  await expect(page.getByTestId('new-folder')).toHaveValue(cwd);
  await expect(page.getByTestId('new-ghostty')).toBeVisible();
  await page.getByTestId('new-herdr').click();
  await expect(page.getByTestId('send-status')).toHaveText('Started Claude Code in herdr');
  await expect.poll(panelVisible).toBe(false);

  const [id] = bundles(cwd);
  const dir = join(cwd, '.feedback', 'sketches', id);
  expect(readdirSync(dir).sort()).toEqual(['board.excalidraw', 'prompt.md', 'sketch.png', 'timeline.md']);
  expect(readFileSync(join(dir, 'prompt.md'), 'utf8')).toContain(`@.feedback/sketches/${id}/sketch.png`);
  const launches = await app.evaluate(() => (globalThis as any).__companion.launches);
  expect(launches.map((l: any) => l.args.slice(0, 2).join(' '))).toEqual(['tab create', 'pane run']);
  expect(launches[0].args).toEqual(['tab', 'create', '--cwd', cwd, '--label', 'sketch', '--focus']);
  expect(launches[1].args).toEqual(['pane', 'run', 'w1:p9', `claude "$(cat '${join(dir, 'prompt.md')}')"`]);
  const history = await app.evaluate(() => (globalThis as any).__companion.history.list());
  expect(history[0]).toMatchObject({ id, target: 'new session (herdr)' });

  // Copy puts a start command on the clipboard instead.
  await showPanel(app, page);
  await page.getByTestId('send').click();
  await page.getByTestId('new-copy').click();
  await expect(page.getByTestId('send-status')).toHaveText(/Copied a command/);
  const copied = await app.evaluate(() => (globalThis as any).__companion.clipboard());
  expect(copied).toMatch(new RegExp(`^cd '${cwd}' && claude "\\$\\(cat '${cwd}/\\.feedback/sketches/[^']+/prompt\\.md'\\)"$`));
});

test('C4.1 through the CLI: draw, read and png against the running app', async () => {
  const env = { ...process.env, COMPANION_SOCKET: socketPath };
  const cli = (args: string[], input?: string) => {
    const p = run('node', [join(ROOT, 'bin/agent-brief.mjs'), ...args], { env, cwd: project() });
    if (input !== undefined) p.child.stdin!.end(input);
    return p;
  };
  const skeletons = {
    elements: [
      { id: 'a', type: 'rectangle', x: 0, y: 0, width: 200, height: 80, label: 'Client', color: 'blue' },
      { id: 'b', type: 'ellipse', x: 320, y: 0, width: 200, height: 80, label: 'Server', color: 'green' },
      { id: 'c', type: 'diamond', x: 160, y: 200, width: 200, height: 100, label: 'Cache' },
      { id: 'ab', type: 'arrow', start: { id: 'a' }, end: { id: 'b' }, label: 'request' },
      { id: 'bc', type: 'arrow', start: { id: 'b' }, end: { id: 'c' } },
    ],
  };
  const drawn = await cli(['draw', '--json'], JSON.stringify(skeletons));
  expect(JSON.parse(drawn.stdout).ids).toEqual(['a', 'b', 'c', 'ab', 'bc']);

  const text = (await cli(['read'])).stdout;
  expect(text).toContain('Client');
  expect(text).toContain('Server');
  expect(text).toContain('Cache');
  const json = JSON.parse((await cli(['read', '--json'])).stdout);
  const ab = json.elements.find((e: any) => e.id === 'ab');
  expect(ab).toMatchObject({ startId: 'a', endId: 'b', label: 'request', by: 'claude' });

  const out = join(project(), 'board.png');
  const png = await cli(['png', '--region', '-20,-20,600,360', '--out', out]);
  expect(png.stdout).toContain(out);
  const bytes = readFileSync(out);
  expect(bytes.subarray(1, 4).toString()).toBe('PNG');
  expect(Math.max(bytes.readUInt32BE(16), bytes.readUInt32BE(20))).toBeLessThanOrEqual(1400);
});

/** Runs the CLI and returns its exit code and output, without throwing on failure. */
async function companion(socket: string, args: string[], input?: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = execFile('node', [join(ROOT, 'bin/agent-brief.mjs'), ...args], { env: { ...process.env, COMPANION_SOCKET: socket } }, (err, stdout, stderr) =>
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr }),
    );
    child.stdin!.end(input ?? '');
  });
}

test('C4.4 the CLI exits 1 for app errors and 2 for bad input, with the reason', async () => {
  const missing = await companion(socketPath, ['read', '--board', 'nope']);
  expect(missing.code).toBe(1);
  expect(missing.stderr).toMatch(/^error \(not_found\): no board named "nope"/);

  const badInput = await companion(socketPath, ['draw'], JSON.stringify({ elements: [{ type: 'rectangle' }, { type: 'blob' }] }));
  expect(badInput.code).toBe(2);
  expect(badInput.stderr).toMatch(/elements\[1\]: "type" must be one of/);

  const badRef = await companion(socketPath, ['draw'], JSON.stringify({ elements: [{ type: 'arrow', start: { id: 'ghost' }, end: { x: 1, y: 1 } }] }));
  expect(badRef.code).toBe(1);
  expect(badRef.stderr).toMatch(/^error \(bad_request\): elements\[0\]\.start: no element with id "ghost"/);
});

test('C4.4 the CLI exits 3 when the app is not running', async () => {
  await ctx.app.close();
  const down = await companion(socketPath, ['read']);
  expect(down.code).toBe(3);
  expect(down.stderr).toMatch(/not running/i);
  // afterEach closes again; relaunch so it has something to close.
  ctx = await launch(tempDataDir());
});
