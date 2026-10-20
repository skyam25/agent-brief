import { expect, test } from '@playwright/test';
import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { BoardsResponse, DeliveriesResponse, Health, OpenResponse, SessionsResponse } from '../src/protocol';
import { backend, type Launched, launchShown, openNotes, RESULTS, ROOT, sceneElements, sendToSession, settled, showPanel, sock } from './helpers';

const run = promisify(execFile);

let ctx: Launched;
let socketPath: string;

test.beforeEach(async () => {
  ({ ctx, socketPath } = await launchShown());
});

test.afterEach(async () => {
  await ctx.app.close();
});

const project = () => mkdtempSync(join(tmpdir(), 'project-'));
const panelVisible = () => ctx.app.evaluate(() => globalThis.__companion.panel.isVisible());

const bundles = (cwd: string) => {
  const dir = join(cwd, '.feedback', 'sketches');
  return existsSync(dir) ? readdirSync(dir) : [];
};

test('C2.4 opened standalone on an owner-only socket, Send asks where to go and never picks a session itself', async () => {
  const { page } = ctx;
  expect(statSync(socketPath).mode & 0o777).toBe(0o600);
  const health = await sock(socketPath, 'GET', '/health');
  expect(health.body).toMatchObject({ ok: true, panelVisible: true, currentBoard: 'scratch' });
  // The notes pane starts collapsed.
  await expect(page.getByTestId('notes-toggle')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('notes')).toHaveCount(0);

  await expect(page.getByTestId('send-menu')).toHaveText('Send to…');
  await page.getByTestId('send').click();
  await expect(page.getByTestId('send-chooser')).toContainText('No Claude Code session has the companion open');

  // A session that registers is listed but not chosen.
  await sock(socketPath, 'POST', '/sessions', { sessionId: 's1', cwd: project(), title: 'Login work', summary: 'tighten the header' });
  await expect(page.getByTestId('send-to-session')).toHaveText(/Login work.*tighten the header/);
  await page.screenshot({ path: join(RESULTS, 'send-chooser.png') });
  expect((await sock<SessionsResponse>(socketPath, 'GET', '/sessions')).body.targetSessionId).toBeUndefined();
  await expect(page.getByTestId('send-menu')).toHaveText('Send to…');
  await expect(page.getByTestId('notes-tab')).toHaveAttribute('aria-current', 'true');
  await expect(page.getByTestId('brief-tab')).toHaveCount(0);
  expect(await panelVisible()).toBe(true);
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
  const scene: { elements: { customData?: { by?: string } }[] } = JSON.parse(readFileSync(join(dir, 'board.excalidraw'), 'utf8'));
  expect(scene.elements.some((e) => e.customData?.by === 'claude')).toBe(true);

  const polled = await sock<DeliveriesResponse>(socketPath, 'GET', '/deliveries?session=s1&wait=0');
  expect(polled.body.deliveries).toHaveLength(1);
  const d = polled.body.deliveries[0];
  expect(d).toMatchObject({ id, sessionId: 's1', dir, mode: 'submit' });
  expect(d.draft).toContain(`@.feedback/sketches/${id}/sketch.png`);
  expect(d.draft).toContain('Notes: the header is too tall');

  const history = await app.evaluate(() => globalThis.__companion.history.list());
  expect(history[0]).toMatchObject({ id, board: 'scratch', target: 'Login work' });

  // The next sketch starts blank; History brings the sent one back on a new board, with its notes.
  await showPanel(app, page);
  expect((await sceneElements(page)).filter((e) => !e.isDeleted)).toHaveLength(0);
  await openNotes(page);
  await expect(page.getByTestId('notes')).toHaveValue('');
  await page.getByTestId('history-toggle').click();
  await expect(page.getByTestId('history-item').first().locator('img')).toBeVisible();
  await page.screenshot({ path: join(RESULTS, 'history.png') });
  await page.getByTestId('history-open').first().click();
  await expect(page.getByTestId('board-picker')).toHaveText(/^scratch \d{2}\.\d{2}$/);
  await expect(page.getByTestId('notes')).toHaveValue('the header is too tall');
  expect((await sceneElements(page)).filter((e) => !e.isDeleted).length).toBeGreaterThan(0);
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
  expect((await sock<DeliveriesResponse>(socketPath, 'GET', '/deliveries?session=sa&wait=0')).body.deliveries).toEqual([]);
  expect((await sock<DeliveriesResponse>(socketPath, 'GET', '/deliveries?session=sb&wait=0')).body.deliveries).toHaveLength(1);
});

test('after a standalone open, the chooser puts the board\'s session first and Copy prompt names the files in full', async () => {
  const { app, page } = ctx;
  const cwd = project();
  await sock(socketPath, 'POST', '/sessions', { sessionId: 'old', cwd, title: 'app', summary: 'an old ask', activeAt: Date.now() - 5 * 86_400_000 });
  await sock(socketPath, 'POST', '/sessions', { sessionId: 'mine', cwd, title: 'app', summary: 'draw the walkthrough', activeAt: Date.now() - 3 * 60_000 });
  await sock(socketPath, 'POST', '/open', { board: 'walkthrough', sessionId: 'mine' });
  await backend(app, 'draw', 'current', { elements: [{ type: 'sticky', x: 0, y: 0, label: 'Scene 1' }] });

  // The shortcut opens standalone, so the target clears and Send asks.
  await app.evaluate(() => globalThis.__companion.panel.hide());
  await showPanel(app, page);
  await expect(page.getByTestId('board-picker')).toHaveText('walkthrough');
  await page.getByTestId('send').click();
  const rows = page.getByTestId('send-to-session');
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText('Has this board');
  await expect(rows.first()).toContainText('draw the walkthrough');
  await expect(rows.first()).toContainText('active 3 min ago');
  await expect(rows.last()).toContainText('active 5 days ago');
  await expect(page.getByTestId('send-holder')).toHaveCount(1);
  await page.screenshot({ path: join(RESULTS, 'send-chooser-holder.png') });

  await page.getByTestId('copy-prompt').click();
  await expect(page.getByTestId('send-status')).toHaveText(/Copied the prompt/);
  const [id] = bundles(cwd);
  const dir = join(cwd, '.feedback', 'sketches', id);
  const copied = await app.evaluate(() => globalThis.__companion.clipboard());
  expect(copied).toContain(`@${dir}/sketch.png`);
  expect(copied).not.toContain('@.feedback/');
  expect((await sock<DeliveriesResponse>(socketPath, 'GET', '/deliveries?session=mine&wait=0')).body.deliveries).toEqual([]);
  const history = await app.evaluate(() => globalThis.__companion.history.list());
  expect(history[0]).toMatchObject({ id, target: 'the clipboard' });
});

test('POST /open shows the board and the prompt and picks the session', async () => {
  const { app, page } = ctx;
  await app.evaluate(() => globalThis.__companion.panel.hide());
  const cwd = project();
  await sock(socketPath, 'POST', '/sessions', { sessionId: 's1', cwd });
  await sock(socketPath, 'POST', '/sessions', { sessionId: 's2', cwd });
  const opened = await sock(socketPath, 'POST', '/open', { board: 'login', prompt: 'Sketch the login screen', sessionId: 's2' });
  expect(opened.body).toEqual({ board: 'login', opened: 'board', targetSessionId: 's2' });
  await expect(page.getByTestId('board-picker')).toHaveText('login');
  await expect(page.getByTestId('prompt')).toHaveText(/Sketch the login screen/);
  await expect(page.getByTestId('crumb-session')).toHaveText(cwd.split('/').pop()!);
  await expect(page.getByTestId('send-menu')).toHaveCount(0);
  expect(await app.evaluate(() => globalThis.__companion.panel.isVisible())).toBe(true);
});

test('a session opened by /sketch is the named Send and the active tab until it leaves; a standalone open starts with none', async () => {
  const { app, page } = ctx;
  const cwd = project();
  await sock(socketPath, 'POST', '/sessions', { sessionId: 's1', cwd, title: 'Login work', host: { terminal: 'ghostty', bundleId: 'com.mitchellh.ghostty' } });
  await sock(socketPath, 'POST', '/open', { sessionId: 's1' });
  await expect(page.getByTestId('crumb-session')).toHaveText('Login work');
  await expect(page.getByTestId('send-menu')).toHaveCount(0);
  const tab = page.getByTestId('brief-tab').filter({ hasText: 'Login work' });
  await expect(tab).toHaveAttribute('aria-current', 'true');
  await page.screenshot({ path: join(RESULTS, 'send-named.png') });

  // A click on the active tab brings the terminal forward.
  await tab.getByRole('tab').click();
  await expect.poll(() => app.evaluate(() => globalThis.__companion.launches.map((l) => l.args.join(' ')).join('\n'))).toContain(
    `working directory is "${cwd}"`,
  );

  // The session leaving clears the target; Send asks again.
  await sock(socketPath, 'DELETE', '/sessions/s1');
  await expect(page.getByTestId('send-menu')).toHaveText('Send to…');
  await expect(page.getByTestId('notes-tab')).toHaveAttribute('aria-current', 'true');
  await expect(page.getByTestId('ended-toggle')).toContainText('Ended 1');

  // Hiding and showing from the hotkey drops a target /sketch set.
  await sock(socketPath, 'POST', '/sessions', { sessionId: 's2', cwd });
  await sock(socketPath, 'POST', '/open', { sessionId: 's2' });
  await expect(page.getByTestId('send-menu')).toHaveCount(0);
  await app.evaluate(() => globalThis.__companion.toggle());
  await expect.poll(panelVisible).toBe(false);
  await showPanel(app, page);
  await expect(page.getByTestId('send-menu')).toHaveText('Send to…');
  expect((await sock<SessionsResponse>(socketPath, 'GET', '/sessions')).body.targetSessionId).toBeUndefined();
});

test('a reopen shows the session\'s last board, and leaves the panel as it is for a session with none', async () => {
  const { page } = ctx;
  const current = async () => (await sock<Health>(socketPath, 'GET', '/health')).body.currentBoard;
  const boardCount = async () => (await sock<BoardsResponse>(socketPath, 'GET', '/boards')).body.boards.length;
  await sock(socketPath, 'POST', '/sessions', { sessionId: 'builder', cwd: project(), title: 'Builder' });
  await sock(socketPath, 'POST', '/sessions', { sessionId: 'writer', cwd: project(), title: 'Writer' });
  await sock(socketPath, 'POST', '/open', { board: 'timeline', sessionId: 'builder' });

  // The user moves to a board under Unfiled.
  const unfiled = async () => {
    await page.getByTestId('notes-tab').getByRole('tab').click();
    await expect(page.getByTestId('notes-tab')).toHaveAttribute('aria-current', 'true');
    await sock(socketPath, 'POST', '/open', { board: 'elsewhere' });
  };
  await sock(socketPath, 'POST', '/boards/elsewhere/draw', { elements: [{ type: 'text', label: 'kept', x: 0, y: 0 }] });
  await unfiled();

  const back = await sock<OpenResponse>(socketPath, 'POST', '/open', { sessionId: 'builder', reopen: true });
  expect(back.body).toMatchObject({ board: 'timeline', opened: 'board', targetSessionId: 'builder' });
  expect(await current()).toBe('timeline');

  await unfiled();
  const boards = await boardCount();
  const none = await sock<OpenResponse>(socketPath, 'POST', '/open', { sessionId: 'writer', reopen: true });
  expect(none.body).toMatchObject({ opened: 'panel', targetSessionId: 'writer' });
  expect(await current()).toBe('elsewhere');
  expect(await boardCount()).toBe(boards);
});

test('/sketch from a session with no brief yet selects its row without passing through Unfiled', async () => {
  const { page } = ctx;
  const cwd = project();
  await sock(socketPath, 'POST', '/sessions', { sessionId: 's1', cwd, title: 'First' });
  await sock(socketPath, 'POST', '/open', { sessionId: 's1' });
  await expect(page.getByTestId('brief-tab').filter({ hasText: 'First' })).toHaveAttribute('aria-current', 'true');

  await sock(socketPath, 'POST', '/sessions', { sessionId: 's2', cwd, title: 'Second' });
  await page.evaluate(() => {
    const w = window as unknown as { __unfiled: boolean };
    w.__unfiled = false;
    const check = () => {
      if (document.querySelector('[data-testid="notes-tab"][aria-current="true"]')) w.__unfiled = true;
    };
    new MutationObserver(check).observe(document.body, { subtree: true, childList: true, attributes: true });
  });
  await sock(socketPath, 'POST', '/open', { sessionId: 's2' });
  await expect(page.getByTestId('brief-tab').filter({ hasText: 'Second' })).toHaveAttribute('aria-current', 'true');
  expect(await page.evaluate(() => (window as unknown as { __unfiled: boolean }).__unfiled)).toBe(false);
});

test('Send to a new session writes the bundle into the folder and starts Claude Code there', async () => {
  const { app, page } = ctx;
  const cwd = project();
  await app.evaluate((_e, cwd) => globalThis.__companion.state.update({ recentProjects: [cwd] }), cwd);
  await backend(app, 'draw', 'current', { elements: [{ type: 'sticky', x: 0, y: 0, label: 'New idea' }] });

  await page.getByTestId('send').click();
  await expect(page.getByTestId('new-folder')).toHaveValue(cwd);
  await expect(page.getByTestId('new-ghostty')).toHaveText('Start in Ghostty');
  // The other launchers wait behind the split button's chevron.
  await expect(page.getByTestId('new-herdr')).toHaveCount(0);
  await page.getByTestId('new-more').click();
  await page.getByTestId('new-herdr').click();
  await expect(page.getByTestId('send-status')).toHaveText('Started Claude Code in herdr');
  await expect.poll(panelVisible).toBe(false);

  const [id] = bundles(cwd);
  const dir = join(cwd, '.feedback', 'sketches', id);
  expect(readdirSync(dir).sort()).toEqual(['board.excalidraw', 'prompt.md', 'sketch.png', 'timeline.md']);
  expect(readFileSync(join(dir, 'prompt.md'), 'utf8')).toContain(`@.feedback/sketches/${id}/sketch.png`);
  const launches = await app.evaluate(() => globalThis.__companion.launches);
  expect(launches.map((l) => l.args.slice(0, 2).join(' '))).toEqual(['tab create', 'pane run']);
  expect(launches[0].args).toEqual(['tab', 'create', '--cwd', cwd, '--label', 'sketch', '--focus']);
  expect(launches[1].args).toEqual(['pane', 'run', 'w1:p9', `claude "$(cat '${join(dir, 'prompt.md')}')"`]);
  const history = await app.evaluate(() => globalThis.__companion.history.list());
  expect(history[0]).toMatchObject({ id, target: 'new session (herdr)' });

  // Copy puts a start command on the clipboard instead.
  await showPanel(app, page);
  await page.getByTestId('send').click();
  await page.getByTestId('new-more').click();
  await page.getByTestId('new-copy').click();
  await expect(page.getByTestId('send-status')).toHaveText(/Copied a command/);
  const copied = await app.evaluate(() => globalThis.__companion.clipboard());
  expect(copied).toMatch(new RegExp(`^cd '${cwd}' && claude "\\$\\(cat '${cwd}/\\.feedback/sketches/[^']+/prompt\\.md'\\)"$`));
});

/** Runs the CLI and returns its exit code and output, without throwing on failure. */
async function companion(socket: string, args: string[], input?: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, COMPANION_SOCKET: socket };
  // Playwright forces color; a runner's NO_COLOR would make Node prefix stderr with a warning.
  delete env.FORCE_COLOR;
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = execFile('node', [join(ROOT, 'bin/agent-brief.mjs'), ...args], { env }, (err, stdout, stderr) =>
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr }),
    );
    child.stdin!.end(input ?? '');
  });
}

test('C4.1 through the CLI: draw, read and png against the running app, and C4.4 its exit codes', async () => {
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
  const json: { elements: { id: string }[] } = JSON.parse((await cli(['read', '--json'])).stdout);
  const ab = json.elements.find((e) => e.id === 'ab');
  expect(ab).toMatchObject({ startId: 'a', endId: 'b', label: 'request', by: 'claude' });

  const out = join(project(), 'board.png');
  const png = await cli(['png', '--region', '-20,-20,600,360', '--out', out]);
  expect(png.stdout).toContain(out);
  const bytes = readFileSync(out);
  expect(bytes.subarray(1, 4).toString()).toBe('PNG');
  expect(Math.max(bytes.readUInt32BE(16), bytes.readUInt32BE(20))).toBeLessThanOrEqual(1400);

  // C4.4 exits 1 for app errors and 2 for bad input, with the reason.
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

test('pinned comments on the board go out as comments.md, and the board stays while the pins clear', async () => {
  const { app, page } = ctx;
  const cwd = project();
  await sock(socketPath, 'POST', '/sessions', { sessionId: 's1', cwd, title: 'Login work' });
  await backend(app, 'draw', 'current', {
    elements: [
      { type: 'frame', id: 'flow', label: 'Login flow' },
      { type: 'rectangle', id: 'start', x: 100, y: 100, label: 'Open the app', frameId: 'flow' },
    ],
  });

  // C turns the tool on; a click on the shape pins it and focuses its card.
  await page.locator('.excalidraw').focus();
  await page.keyboard.press('c');
  await expect(page.getByTestId('comment-tool')).toHaveAttribute('aria-pressed', 'true');
  await settled(page);
  const spot = await page.evaluate(() => {
    const s = window.__excalidraw.getAppState();
    const e = window.__excalidraw.getSceneElements().find((x) => x.id === 'start')!;
    return { x: (e.x + 20 + s.scrollX) * s.zoom.value + s.offsetLeft, y: (e.y + 20 + s.scrollY) * s.zoom.value + s.offsetTop };
  });
  await page.mouse.click(spot.x, spot.y);
  await expect(page.getByTestId('board-pin')).toHaveCount(1);
  await expect(page.getByTestId('board-comment-card')).toContainText('rectangle “Open the app”');
  await expect(page.getByTestId('board-comment-text')).toBeFocused();
  await page.keyboard.type('Say what opens first.');
  expect((await sceneElements(page)).filter((e) => !e.isDeleted).map((e) => e.id).sort()).toEqual(expect.arrayContaining(['flow', 'start']));
  await page.screenshot({ path: join(RESULTS, 'board-comments.png') });

  await sendToSession(page, 'Login work');
  await expect(page.getByTestId('send-status')).toHaveText('Sent to Login work');
  const [id] = bundles(cwd);
  const dir = join(cwd, '.feedback', 'sketches', id);
  copyFileSync(join(dir, 'sketch.png'), join(RESULTS, 'board-comments-sent.png'));
  const md = readFileSync(join(dir, 'comments.md'), 'utf8');
  expect(md).toContain('## 1. rectangle “Open the app”\n\nSay what opens first.\n\n- Element: `start`\n- In frame: “Login flow”');
  const delivered = (await sock<DeliveriesResponse>(socketPath, 'GET', '/deliveries?session=s1&wait=0')).body.deliveries[0];
  expect(delivered.draft.split('\n').slice(0, 2)).toEqual([
    `@.feedback/sketches/${id}/comments.md`,
    'Feedback on the board "scratch" from Agent Brief, 1 comment pinned to the board. Make the changes, on the board where they belong, then say what changed.',
  ]);

  // The board stays for Claude to revise; the pins and the column go.
  expect((await sceneElements(page)).filter((e) => !e.isDeleted).length).toBeGreaterThan(0);
  await showPanel(app, page);
  await expect(page.getByTestId('board-pin')).toHaveCount(0);
  await expect(page.getByTestId('board-comments')).toHaveCount(0);
});
