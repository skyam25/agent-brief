import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
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
