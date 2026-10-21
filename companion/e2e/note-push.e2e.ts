import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { NoteResponse } from '../src/protocol';
import { launchShown, type Launched, RESULTS, ROOT, sock } from './helpers';

let ctx: Launched;
let socketPath: string;

test.beforeEach(async () => {
  ({ ctx, socketPath } = await launchShown());
});

test.afterEach(async () => {
  await ctx.app.close();
});

const POST = 'Hi team,\n\nWe shipped **v2** today.\n\n- faster sync\n- [the changelog](https://example.com/changes)';
const panelVisible = () => ctx.app.evaluate(() => globalThis.__companion.panel.isVisible());
const selectedBody = () => ctx.page.evaluate(() => window.__drafts.selected?.body);

test('a pushed note joins the open Write view, keeps the open note, and copies as rich text', async () => {
  const { app, page } = ctx;
  const cwd = mkdtempSync(join(tmpdir(), 'project-'));
  await sock(socketPath, 'POST', '/sessions', { sessionId: 's1', cwd, title: 'Launch' });
  await sock(socketPath, 'POST', '/open', { sessionId: 's1', mode: 'write', text: 'my own thoughts' });
  await expect.poll(selectedBody).toBe('my own thoughts');

  const res = await sock<NoteResponse>(socketPath, 'POST', '/notes', { sessionId: 's1', title: 'Launch message', text: POST });
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
  const row = page.getByTestId('draft-row').filter({ hasText: 'Launch message' });
  await expect(row).toBeVisible();
  await expect(row).toContainText('Hi team,');
  expect(await selectedBody(), 'the open note stays open').toBe('my own thoughts');

  await row.click();
  await expect(page.getByTestId('draft-title')).toHaveText('Launch message');
  await page.screenshot({ path: join(RESULTS, 'note-push.png') });
  await page.getByTestId('draft-copy').click();
  await expect(page.getByTestId('draft-copy')).toHaveText('Copied');
  const clip = await app.evaluate(() => globalThis.__companion.richClipboard());
  expect(clip?.text).toBe(POST);
  expect(clip?.html).toContain('<strong>v2</strong>');
  expect(clip?.html).toContain('<ul><li>faster sync</li><li><a href="https://example.com/changes">the changelog</a></li></ul>');
  await expect(page.getByTestId('draft-copy')).toHaveText('Copy', { timeout: 4000 });
});

test('a note pushed while the panel is hidden leaves it hidden, and the CLI files it under its session', async () => {
  const { app } = ctx;
  const cwd = mkdtempSync(join(tmpdir(), 'project-'));
  await sock(socketPath, 'POST', '/sessions', { sessionId: 's2', cwd, title: 'Email' });
  await app.evaluate(() => globalThis.__companion.panel.hide());

  const out = execFileSync('node', [join(ROOT, 'bin/agent-brief.mjs'), 'note', 'Reply to Sam'], {
    input: 'Dear Sam,\n\nThanks for the notes.',
    env: { ...process.env, COMPANION_SOCKET: socketPath, CLAUDE_CODE_SESSION_ID: 's2' },
  }).toString();
  expect(out).toContain(`Saved "Reply to Sam" to this session's tab`);
  expect(await panelVisible()).toBe(false);

  const saved = await app.evaluate(() => globalThis.__companion.drafts.list().find((d) => d.title === 'Reply to Sam'));
  expect(saved).toMatchObject({ sessionId: 's2', status: 'note', body: 'Dear Sam,\n\nThanks for the notes.' });
  const tabs = await app.evaluate(() => Object.keys(globalThis.__companion.state.state.sessionBriefs ?? {}));
  expect(tabs).toContain('s2');

  expect((await sock(socketPath, 'POST', '/notes', { sessionId: 'nobody', text: 'x' })).status).toBe(404);
});

test('the open line the CLI prints shows that note in Write, not a board', async () => {
  const { app, page } = ctx;
  const cwd = mkdtempSync(join(tmpdir(), 'project-'));
  await sock(socketPath, 'POST', '/sessions', { sessionId: 's3', cwd, title: 'Recap' });
  await sock(socketPath, 'POST', '/open', { sessionId: 's3', board: 'release-notes' });
  await app.evaluate(() => globalThis.__companion.panel.hide());

  const env = { ...process.env, COMPANION_SOCKET: socketPath, CLAUDE_CODE_SESSION_ID: 's3' };
  const cli = (args: string[], input = '') => execFileSync('node', [join(ROOT, 'bin/agent-brief.mjs'), ...args], { input, env }).toString();
  const saved = cli(['note', 'Interview questions recap'], '# Recap\n\nBlock 1');
  const line = /agent-brief open --note (\S+)/.exec(saved);
  expect(line, saved).not.toBeNull();
  expect(await panelVisible()).toBe(false);

  expect(cli(['open', '--note', line![1]])).toContain('opened note');
  await expect.poll(panelVisible).toBe(true);
  await expect(page.getByTestId('draft-title')).toHaveText('Interview questions recap');
  expect(await selectedBody()).toBe('# Recap\n\nBlock 1');
  await page.screenshot({ path: join(RESULTS, 'note-open.png') });

  expect((await sock(socketPath, 'POST', '/open', { note: { id: 'missing' } })).status).toBe(400);
});

test('open --note leaves Unfiled for the note\'s session when the panel has no target, as after a restart', async () => {
  const { page } = ctx;
  const cwd = mkdtempSync(join(tmpdir(), 'project-'));
  await sock(socketPath, 'POST', '/sessions', { sessionId: 's4', cwd, title: 'pm-interview' });
  await page.getByTestId('mode-write').click();
  await expect(page.getByTestId('mode-write')).toHaveAttribute('aria-selected', 'true');
  expect((await sock<{ targetSessionId?: string }>(socketPath, 'GET', '/sessions')).body.targetSessionId).toBeUndefined();

  const env = { ...process.env, COMPANION_SOCKET: socketPath, CLAUDE_CODE_SESSION_ID: 's4' };
  const cli = (args: string[], input = '') => execFileSync('node', [join(ROOT, 'bin/agent-brief.mjs'), ...args], { input, env }).toString();
  const id = /agent-brief open --note (\S+)/.exec(cli(['note', 'Senior PM questions'], 'Block 1'))![1];
  expect(cli(['open', '--note', id])).toContain('send target s4');

  await expect(page.getByTestId('draft-title')).toHaveText('Senior PM questions');
  await expect.poll(selectedBody).toBe('Block 1');
  // Nothing replaces it once the tab switch settles.
  await page.waitForTimeout(500);
  expect(await selectedBody()).toBe('Block 1');
  await page.screenshot({ path: join(RESULTS, 'note-open-unfiled.png') });
});

test('note --id replaces the open note in place, so the user keeps one copy', async () => {
  const { page } = ctx;
  const cwd = mkdtempSync(join(tmpdir(), 'project-'));
  await sock(socketPath, 'POST', '/sessions', { sessionId: 's5', cwd, title: 'pm-interview' });
  const env = { ...process.env, COMPANION_SOCKET: socketPath, CLAUDE_CODE_SESSION_ID: 's5' };
  const cli = (args: string[], input = '') => execFileSync('node', [join(ROOT, 'bin/agent-brief.mjs'), ...args], { input, env }).toString();
  const saved = cli(['note', 'Interview approach'], 'Two acts, long probes');
  const id = /agent-brief open --note (\S+)/.exec(saved)![1]!;
  expect(saved).toContain(`agent-brief note --id ${id}`);
  cli(['open', '--note', id]);
  await expect.poll(selectedBody).toBe('Two acts, long probes');

  expect(cli(['note', '--id', id], 'One act, short probes')).toContain('Updated note');
  await expect.poll(selectedBody).toBe('One act, short probes');
  await expect(page.getByTestId('draft-title')).toHaveText('Interview approach');
  await expect(page.getByTestId('draft-row')).toHaveCount(1);
  expect((await sock(socketPath, 'POST', '/notes', { draftId: 'missing-id', text: 'x' })).status).toBe(400);
});

test('a note opened while Review shows a page lands in Write and stays there', async () => {
  const { page } = ctx;
  const cwd = mkdtempSync(join(tmpdir(), 'project-'));
  mkdirSync(join(cwd, 'docs'));
  mkdirSync(join(cwd, '.feedback/outputs'), { recursive: true });
  writeFileSync(join(cwd, 'docs/pricing.html'), '<h1>Pricing</h1>');
  const output = { ref: 'docs/pricing.html', kind: 'html', tier: 'declared', title: 'Pricing', status: 'ready', declaredAt: 1 };
  writeFileSync(join(cwd, '.feedback/outputs/s4.json'), JSON.stringify({ version: 1, sessionId: 's4', outputs: [output] }));
  await sock(socketPath, 'POST', '/sessions', { sessionId: 's4', cwd, title: 'Pricing' });

  await sock(socketPath, 'POST', '/open', { sessionId: 's4', output: { path: join(cwd, 'docs/pricing.html') } });
  await expect(page.frameLocator('[data-testid="review-frame"]').locator('h1')).toHaveText('Pricing');

  const note = await sock<NoteResponse>(socketPath, 'POST', '/notes', { sessionId: 's4', title: 'Slack: pricing', text: 'Hi team, the pricing page is up.' });
  expect((await sock(socketPath, 'POST', '/open', { note: { id: note.body.draftId } })).body).toMatchObject({ opened: 'note' });
  await expect(page.getByTestId('mode-write')).toHaveAttribute('aria-selected', 'true');
  await expect.poll(selectedBody).toBe('Hi team, the pricing page is up.');
  await page.waitForTimeout(1000);
  await expect(page.getByTestId('mode-write'), 'Review does not take the panel back').toHaveAttribute('aria-selected', 'true');
  expect(await selectedBody()).toBe('Hi team, the pricing page is up.');
});
