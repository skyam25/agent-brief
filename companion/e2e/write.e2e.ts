import { expect, test, type Page } from '@playwright/test';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DeliveriesResponse, SessionsResponse } from '../src/protocol';
import { backend, draftBody, launch, type Launched, launchShown, RESULTS, ROOT, sendToSession, showPanel, sock, tempDataDir, typeDraft } from './helpers';

let ctx: Launched;
let socketPath: string;
let dataDir: string;

test.beforeEach(async () => {
  ({ ctx, socketPath, dataDir } = await launchShown());
});

test.afterEach(async () => {
  await ctx.app.close();
});

const project = () => mkdtempSync(join(tmpdir(), 'project-'));
const panelVisible = () => ctx.app.evaluate(() => globalThis.__companion.panel.isVisible());
const draftsOnDisk = () =>
  readdirSync(join(dataDir, 'drafts'))
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(dataDir, 'drafts', f), 'utf8')));
const deliveries = async (session: string) =>
  (await sock<DeliveriesResponse>(socketPath, 'GET', `/deliveries?session=${session}&wait=0`)).body.deliveries;

async function writeNote(page: Page, text: string): Promise<void> {
  await page.getByTestId('draft-new').click();
  await typeDraft(page, text);
}

test('Write mode keeps notes on disk and comes back in the same mode', async () => {
  let { app, page } = ctx;
  await page.getByTestId('mode-write').click();
  await expect(page.getByTestId('write')).toBeVisible();
  await expect(page.getByTestId('draft-body')).toBeFocused();
  // A note stays off disk until it has words.
  expect(draftsOnDisk()).toHaveLength(0);
  await typeDraft(page, 'Idea: queue prompts for later\nwith a second line');
  // Each line is a paragraph, so the Markdown has a blank line between them.
  await expect.poll(() => draftsOnDisk().map((d) => d.body)).toEqual(['Idea: queue prompts for later\n\nwith a second line']);
  await expect(page.getByTestId('draft-row').first()).toContainText('Idea: queue prompts for later');
  await page.screenshot({ path: join(RESULTS, 'write-mode.png') });

  await app.close();
  ({ app, page } = ctx = await launch(dataDir));
  await showPanel(app, page);
  await expect(page.getByTestId('mode-write')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('draft-body').locator('p')).toHaveText(['Idea: queue prompts for later', 'with a second line']);
  expect(await draftBody(page)).toBe('Idea: queue prompts for later\n\nwith a second line');

  // ⌘1 goes back to the board.
  await page.keyboard.press('Meta+1');
  await expect(page.getByTestId('write')).toHaveCount(0);
  await expect(page.getByTestId('board-picker')).toBeVisible();
});

test('Ready drafts queue in order and Send uses one up', async () => {
  const { app, page } = ctx;
  const cwd = project();
  await sock(socketPath, 'POST', '/sessions', { sessionId: 's1', cwd, title: 'Login work' });

  await page.getByTestId('mode-write').click();
  for (const text of ['First task', 'Second task', 'Third task']) {
    await writeNote(page, text);
    await page.keyboard.press('Meta+Shift+Enter');
  }
  const ready = page.getByTestId('ready-list').getByTestId('draft-row');
  await expect(ready).toHaveText([/First task/, /Second task/, /Third task/]);

  // ⌥↑ moves the third task to the front of the queue.
  await ready.nth(2).focus();
  await page.keyboard.press('Alt+ArrowUp');
  await page.keyboard.press('Alt+ArrowUp');
  await expect(ready).toHaveText([/Third task/, /First task/, /Second task/]);
  await page.screenshot({ path: join(RESULTS, 'write-queue.png') });

  await ready.first().click();
  await sendToSession(page, 'Login work');
  await expect.poll(panelVisible).toBe(false);

  const [d] = await deliveries('s1');
  expect(d.draft).toBe('Third task');
  expect(readFileSync(join(d.dir, 'draft.md'), 'utf8')).toBe('Third task');
  expect(existsSync(join(d.dir, 'sketch.png'))).toBe(false);
  await expect.poll(() => draftsOnDisk().map((x) => x.body).sort()).toEqual(['First task', 'Second task']);

  // History keeps the text and opens it again as a new note.
  const [entry] = await app.evaluate(() => globalThis.__companion.history.list());
  expect(entry).toMatchObject({ text: 'Third task', target: 'Login work' });
  expect(entry.board).toBeUndefined();
  await showPanel(app, page);
  await page.getByTestId('history-toggle').click();
  await expect(page.getByTestId('history-item').first()).toContainText('Third task');
  await page.getByTestId('history-open').first().click();
  await expect(page.getByTestId('draft-body')).toHaveText('Third task');
  await expect.poll(() => draftBody(page)).toBe('Third task');
});

test('right-clicking a draft row marks it Ready or deletes it', async () => {
  const { page } = ctx;
  await page.getByTestId('mode-write').click();
  await writeNote(page, 'Keep this one');
  await writeNote(page, 'Throw this away');
  await expect.poll(() => draftsOnDisk().length).toBe(2);
  const row = (text: string) => page.getByTestId('draft-row').filter({ hasText: text });

  await row('Keep this one').click({ button: 'right' });
  await expect(page.getByTestId('row-menu')).toBeVisible();
  await page.getByTestId('row-menu-ready').click();
  await expect(page.getByTestId('row-menu')).toHaveCount(0);
  await expect(page.getByTestId('ready-list').getByTestId('draft-row')).toHaveText([/Keep this one/]);

  // Delete asks once more before it deletes.
  await row('Throw this away').click({ button: 'right' });
  await page.getByTestId('row-menu-delete').click();
  await expect(page.getByTestId('row-menu-delete')).toHaveText('Click again to delete');
  await page.screenshot({ path: join(RESULTS, 'write-row-menu.png') });
  await page.getByTestId('row-menu-delete').click();
  await expect(row('Throw this away')).toHaveCount(0);
  await expect.poll(() => draftsOnDisk().map((d) => d.body)).toEqual(['Keep this one']);

  // Escape closes the menu and leaves the panel up.
  await row('Keep this one').click({ button: 'right' });
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('row-menu')).toHaveCount(0);
  expect(await panelVisible()).toBe(true);
});

test('Send in Write mode refuses an empty draft and never picks a session', async () => {
  const { page } = ctx;
  await sock(socketPath, 'POST', '/sessions', { sessionId: 's1', cwd: project(), title: 'Login work' });
  await page.getByTestId('mode-write').click();
  await typeDraft(page, 'Something to send');
  // Opened standalone, Send asks where to go first.
  await page.getByTestId('send').click();
  await expect(page.getByTestId('send-chooser')).toBeVisible();
  await page.keyboard.press('Escape');

  // An empty note says so before any session is picked.
  await page.getByTestId('draft-new').click();
  await page.getByTestId('draft-new').click();
  await page.getByTestId('send').click();
  await expect(page.getByTestId('send-status')).toHaveText('Write something first.');
  await expect(page.getByTestId('send-chooser')).toHaveCount(0);
  expect(await deliveries('s1')).toHaveLength(0);
});

test('a draft pulled into a sketch leads the prompt and goes with it', async () => {
  const { app, page } = ctx;
  await sock(socketPath, 'POST', '/sessions', { sessionId: 's1', cwd: project(), title: 'Login work' });
  await page.getByTestId('mode-write').click();
  await typeDraft(page, 'Build this checkout flow');
  await page.keyboard.press('Meta+1');

  await backend(app, 'draw', 'current', { elements: [{ type: 'sticky', x: 0, y: 0, label: 'Pay' }] });
  await page.getByTestId('pull-in').click();
  await page.getByTestId('pull-in-item').filter({ hasText: 'Build this checkout flow' }).click();
  await expect(page.getByTestId('pulled-draft')).toContainText('Build this checkout flow');
  await page.screenshot({ path: join(RESULTS, 'write-pulled-in.png') });
  await expect.poll(() => draftsOnDisk()[0]?.board).toBe('scratch');

  await sendToSession(page, 'Login work');
  await expect.poll(panelVisible).toBe(false);
  const [d] = await deliveries('s1');
  expect(d.draft.split('\n').slice(0, 3)).toEqual(['Build this checkout flow', '', `@.feedback/sketches/${d.id}/sketch.png`]);
  await expect.poll(() => draftsOnDisk()).toHaveLength(0);

  await showPanel(app, page);
  await expect(page.getByTestId('pulled-draft')).toHaveCount(0);
});

test('a draft that carries a board sends its sketch from Write mode', async () => {
  const { app, page } = ctx;
  await sock(socketPath, 'POST', '/sessions', { sessionId: 's1', cwd: project(), title: 'Login work' });
  await backend(app, 'draw', 'current', { elements: [{ type: 'sticky', x: 0, y: 0, label: 'Header' }] });
  await page.getByTestId('mode-write').click();
  await typeDraft(page, 'Tighten this header');
  await page.getByTestId('draft-board').selectOption('scratch');
  await expect(page.getByTestId('draft-row').first()).toContainText('scratch');

  await sendToSession(page, 'Login work');
  await expect.poll(panelVisible).toBe(false);
  const [d] = await deliveries('s1');
  expect(d.draft).toMatch(/^Tighten this header\n\n@\.feedback\/sketches\/.+\/sketch\.png/);
  expect(readdirSync(d.dir).sort()).toEqual(['board.excalidraw', 'draft.md', 'sketch.png', 'timeline.md']);
});

test('the capture shortcut opens a new note in Write mode', async () => {
  const { app, page } = ctx;
  await app.evaluate(() => globalThis.__companion.toggle());
  expect(await panelVisible()).toBe(false);
  const keys = await app.evaluate(() => [...globalThis.__companion.registrar.registered.keys()]);
  expect(keys).toEqual(['Control+Alt+S', 'Control+Alt+N']);

  await app.evaluate(() => globalThis.__companion.registrar.registered.get('Control+Alt+N')!());
  expect(await panelVisible()).toBe(true);
  await expect(page.getByTestId('write')).toBeVisible();
  await expect(page.getByTestId('draft-body')).toHaveText('');
  await expect(page.getByTestId('draft-body')).toBeFocused();
  await page.keyboard.type('remember to check the iPad network');
  // Escape hides the panel; the note is already saved.
  await page.keyboard.press('Escape');
  await expect.poll(panelVisible).toBe(false);
  await expect.poll(() => draftsOnDisk().map((d) => d.body)).toEqual(['remember to check the iPad network']);
});

test('/sketch with no prompt leaves Write mode, and capture afterwards picks no session', async () => {
  const { app, page } = ctx;
  await sock(socketPath, 'POST', '/sessions', { sessionId: 's1', cwd: project(), title: 'Login work' });
  await page.getByTestId('mode-write').click();
  await typeDraft(page, 'a note');

  await sock(socketPath, 'POST', '/open', { board: 'scratch', sessionId: 's1' });
  await expect(page.getByTestId('write')).toHaveCount(0);
  await expect(page.getByTestId('send-menu')).toHaveText('Login work');

  // The panel is still up and bound to s1; a captured note must not inherit it.
  await app.evaluate(() => globalThis.__companion.newNote());
  await expect(page.getByTestId('write')).toBeVisible();
  expect((await sock<SessionsResponse>(socketPath, 'GET', '/sessions')).body.targetSessionId).toBeUndefined();
  await expect(page.getByTestId('send-menu')).toHaveText('Choose a session');
});

test('/write can start the note with text from Claude Code', async () => {
  const { page } = ctx;
  await sock(socketPath, 'POST', '/sessions', { sessionId: 's1', cwd: project(), title: 'Login work' });
  await sock(socketPath, 'POST', '/open', { sessionId: 's1', mode: 'write', text: 'Plan:\n1. Add the button' });
  await expect(page.getByTestId('write')).toBeVisible();
  await expect(page.getByTestId('draft-body').locator(':scope > p').first()).toHaveText('Plan:');
  await expect(page.getByTestId('draft-body').locator('ol li')).toHaveText('Add the button');
  await expect.poll(() => draftsOnDisk().map((d) => d.body)).toEqual(['Plan:\n1. Add the button']);
});

test('/write opens a new note bound to the session, and Send delivers it there', async () => {
  const { app, page } = ctx;
  await sock(socketPath, 'POST', '/sessions', { sessionId: 's1', cwd: project(), title: 'Login work' });
  await app.evaluate(() => globalThis.__companion.toggle());
  expect(await panelVisible()).toBe(false);

  await sock(socketPath, 'POST', '/open', { sessionId: 's1', mode: 'write', prompt: 'the release notes' });
  expect(await panelVisible()).toBe(true);
  await expect(page.getByTestId('write')).toBeVisible();
  await expect(page.getByTestId('draft-body')).toHaveText('');
  await expect(page.getByTestId('draft-body')).toBeFocused();
  expect((await sock<SessionsResponse>(socketPath, 'GET', '/sessions')).body.targetSessionId).toBe('s1');

  await page.keyboard.type('Ship 0.2.2 with the Write button');
  await page.getByTestId('send').click();
  await expect.poll(panelVisible).toBe(false);
  const [d] = await deliveries('s1');
  expect(d.draft).toBe('Ship 0.2.2 with the Write button');
});

test('switching to Write stops a recording', async () => {
  await ctx.app.close();
  ctx = await launch(tempDataDir(), { COMPANION_TEST_AUDIO: join(ROOT, 'e2e/fixtures/speech.wav') });
  const { app, page } = ctx;
  await showPanel(app, page);
  await page.getByTestId('mic').click();
  await expect(page.getByTestId('mic')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('mode-write').click();
  await expect.poll(() => page.evaluate(() => window.__board.recorder.recording)).toBe(false);
});
