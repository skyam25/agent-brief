import { expect, test } from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Initiative } from '../src/protocol';
import { launch, type Launched, showPanel, sock, tempDataDir } from './helpers';

let ctx: Launched;
let socketPath: string;
let folder: string;

test.beforeEach(async () => {
  const dataDir = tempDataDir();
  socketPath = join(dataDir, 'companion.sock');
  folder = mkdtempSync(join(tmpdir(), 'initiative-'));
  ctx = await launch(dataDir, { COMPANION_TEST_FOLDER: folder });
  await expect.poll(() => existsSync(socketPath)).toBe(true);
});

test.afterEach(async () => {
  await ctx.app.close();
});

test('an external revision conflicts with an Understanding edit already in progress', async () => {
  const created = await sock<Initiative>(socketPath, 'POST', '/initiatives', { title: 'Concurrent', folder, updatedBy: 'PM' });
  const id = created.body.id;
  const { app, page } = ctx;
  await showPanel(app, page);
  await page.getByTestId('mode-initiative').click();
  await expect(page.getByTestId('initiative-heading')).toHaveText('Concurrent');
  await page.getByTestId('initiative-understanding').fill('My unsaved draft');
  await sock(socketPath, 'PUT', `/initiatives/${id}`, { revision: 1, understanding: 'New agent work', updatedBy: 'Claude' });
  await expect(page.getByTestId('initiative-sessions')).toContainText('revision 2');
  await expect(page.getByTestId('initiative-understanding')).toHaveValue('My unsaved draft');
  await page.getByTestId('initiative-save').click();
  await expect(page.getByTestId('send-status')).toContainText('Not saved:');
  expect((await sock<Initiative>(socketPath, 'GET', `/initiatives/${id}`)).body.understanding).toBe('New agent work');
  await expect(page.getByTestId('initiative-understanding')).toHaveValue('My unsaved draft');
  await page.getByRole('button', { name: 'Revert', exact: true }).click();
  await expect(page.getByTestId('initiative-understanding')).toHaveValue('New agent work');
  await page.getByTestId('initiative-understanding').fill('Revised from latest');
  await page.getByTestId('initiative-save').click();
  await expect(page.getByTestId('initiative-sessions')).toContainText('revision 3');
});

test('the Initiative tab creates a brief, saves Understanding, and follows edits from outside', async () => {
  const { app, page } = ctx;
  await showPanel(app, page);
  await page.getByTestId('mode-initiative').click();
  await expect(page.getByTestId('initiative-empty')).toContainText('No initiatives yet');

  await page.getByTestId('initiative-new').click();
  await page.getByTestId('initiative-title').fill('Pricing');
  await page.getByTestId('initiative-folder').click();
  await page.getByTestId('initiative-create').click();

  await expect(page.getByTestId('initiative-heading')).toHaveText('Pricing');
  await expect(page.getByTestId('initiative-row')).toHaveText(/Pricing/);
  await expect(page.getByTestId('initiative-outputs')).toHaveCount(0);
  const brief = join(folder, 'Pricing brief.md');
  expect(readFileSync(brief, 'utf8')).toMatch(/^---\nagent_brief_id: "[0-9a-f]+"\n---\n# Pricing\n/);

  // Copy reference attaches by id, so a shared title cannot pick the wrong brief.
  const id = readFileSync(brief, 'utf8').match(/agent_brief_id: "([0-9a-f]+)"/)![1];
  await page.getByTestId('initiative-copy-reference').click();
  await expect
    .poll(() => app.evaluate(() => globalThis.__companion.clipboard()))
    .toBe(`Attach my Agent Brief initiative "Pricing" with agent-brief initiative attach '${id}', then read it with agent-brief initiative show '${id}'.`);
  await expect(page.getByTestId('initiative-sessions')).toContainText('No session attached · revision 1 by PM');

  await page.getByTestId('initiative-understanding').fill('Monthly-first wins on trials. Legal next.');
  await expect(page.getByTestId('initiative-words')).toHaveText('6 words');
  await page.getByTestId('initiative-save').click();
  await expect(page.getByTestId('initiative-sessions')).toContainText('revision 2 by PM');
  expect(readFileSync(brief, 'utf8')).toContain('## Understanding\nMonthly-first wins on trials. Legal next.\n');

  // An edit by hand reaches the open pane as a push and becomes the PM's revision.
  writeFileSync(brief, readFileSync(brief, 'utf8').replace('## Open\n', '## Open\n- Legal review of trial terms\n'));
  await expect(page.getByTestId('initiative-pane')).toContainText('Legal review of trial terms');
  await expect(page.getByTestId('initiative-sessions')).toContainText('revision 3 by PM');

  // A session that attaches shows in the pane.
  const [summary] = (await sock<Initiative[]>(socketPath, 'GET', '/initiatives')).body;
  await sock(socketPath, 'POST', '/sessions', { sessionId: 'sess-1', cwd: folder, title: 'pricing work' });
  expect((await sock(socketPath, 'PUT', '/sessions/sess-1/initiative', { initiativeId: summary.id })).status).toBe(200);
  await expect(page.getByTestId('initiative-sessions')).toContainText('Attached to');

  await page.getByTestId('initiative-reveal').first().click();
  await expect.poll(() => app.evaluate(() => globalThis.__companion.openedOutputs)).toContain(`reveal:${folder}`);
});

test('an attached session files its ready outputs in the brief, and /open shows an initiative', async () => {
  const pricing = (await sock<Initiative>(socketPath, 'POST', '/initiatives', { title: 'Pricing', folder, updatedBy: 'PM' })).body;
  const checkout = (await sock<Initiative>(socketPath, 'POST', '/initiatives', { title: 'Checkout', folder, updatedBy: 'PM' })).body;
  const cwd = mkdtempSync(join(tmpdir(), 'initiative-project-'));
  const ready = { ref: 'docs/prd.md', title: 'Checkout PRD', kind: 'markdown', tier: 'declared', status: 'ready', declaredAt: Date.now() };
  mkdirSync(join(cwd, '.feedback', 'outputs'), { recursive: true });
  writeFileSync(join(cwd, '.feedback', 'outputs', 'ini-1.json'), JSON.stringify({ version: 1, sessionId: 'ini-1', outputs: [ready] }));
  await sock(socketPath, 'POST', '/sessions', { sessionId: 'ini-1', cwd, title: 'Checkout work' });

  // An attach files what the session already has.
  const row = `Checkout PRD [prd.md](<file:${join(cwd, 'docs/prd.md')}>)`;
  await sock(socketPath, 'PUT', '/sessions/ini-1/initiative', { initiativeId: checkout.id });
  await expect.poll(() => readFileSync(checkout.path, 'utf8')).toContain(`## Outputs\n- ${row}\n`);
  expect((await sock<{ outputs?: string[] }>(socketPath, 'GET', '/sessions/ini-1/initiative')).body.outputs).toEqual([row]);

  // A later ready output joins through the file watch.
  const deck = { ref: 'https://claude.ai/artifact/abc', url: 'https://claude.ai/artifact/abc', title: 'Review deck', kind: 'artifact', tier: 'declared', status: 'ready', declaredAt: Date.now() };
  writeFileSync(join(cwd, '.feedback', 'outputs', 'ini-1.json'), JSON.stringify({ version: 1, sessionId: 'ini-1', outputs: [ready, deck] }));
  await expect.poll(() => readFileSync(checkout.path, 'utf8')).toContain(`- ${row}\n- [Review deck](https://claude.ai/artifact/abc)\n`);
  expect((await sock<Initiative>(socketPath, 'GET', `/initiatives/${checkout.id}`)).body.updatedBy).toBe('Agent Brief · ini-1');
  expect(readFileSync(pricing.path, 'utf8')).not.toContain('prd.md');

  // /open shows the Initiative view on the one asked for, with the session as the Send target.
  const opened = await sock<{ opened?: string; targetSessionId?: string }>(socketPath, 'POST', '/open', { sessionId: 'ini-1', initiative: { id: pricing.id } });
  expect(opened.body).toMatchObject({ opened: 'initiative', targetSessionId: 'ini-1' });
  const { page } = ctx;
  await expect(page.getByTestId('initiative-heading')).toHaveText('Pricing');
  await expect(page.getByTestId('mode-initiative')).toHaveAttribute('aria-selected', 'true');
  await sock(socketPath, 'POST', '/open', { initiative: { id: checkout.id } });
  await expect(page.getByTestId('initiative-heading')).toHaveText('Checkout');
});

test('brief lines show their links as labels, and Outputs lists the rows that open', async () => {
  const { app, page } = ctx;
  const cwd = mkdtempSync(join(tmpdir(), 'initiative-project-'));
  mkdirSync(join(cwd, 'docs'), { recursive: true });
  writeFileSync(join(cwd, 'docs', 'prd.md'), '# Pricing PRD\n');
  writeFileSync(join(folder, 'D-001.md'), '# D-001\n');
  const decision = `2026-10-14 Three tiers → [D-001](<file:${join(folder, 'D-001.md')}>)`;
  const created = (await sock<Initiative>(socketPath, 'POST', '/initiatives', { title: 'Pricing', folder, decisions: [decision], open: ['Legal, see [thread](https://example.com/legal)'], updatedBy: 'PM' })).body;
  await sock(socketPath, 'POST', '/sessions', { sessionId: 'ini-2', cwd, title: 'Pricing work' });
  await sock(socketPath, 'PUT', '/sessions/ini-2/initiative', { initiativeId: created.id });
  mkdirSync(join(cwd, '.feedback', 'outputs'), { recursive: true });
  const ready = { ref: 'docs/prd.md', title: 'Pricing PRD', kind: 'markdown', tier: 'declared', status: 'ready', declaredAt: Date.now() };
  writeFileSync(join(cwd, '.feedback', 'outputs', 'ini-2.json'), JSON.stringify({ version: 1, sessionId: 'ini-2', outputs: [ready] }));
  await expect.poll(() => readFileSync(created.path, 'utf8')).toContain('Pricing PRD [prd.md]');

  await showPanel(app, page);
  await page.getByTestId('mode-initiative').click();
  const pane = page.getByTestId('initiative-pane');
  await expect(pane).toContainText('2026-10-14 Three tiers → D-001');
  await expect(pane).not.toContainText('file:');
  await expect(pane).toContainText('Legal, see thread');
  const outputs = page.getByTestId('initiative-outputs');
  await expect(outputs).toContainText('Outputs');
  await expect(outputs.locator('li')).toHaveText(['Pricing PRD prd.md']);
  // The stored text keeps its Markdown.
  expect(readFileSync(created.path, 'utf8')).toContain(`- ${decision}\n`);

  // A file in no session's folder opens in its app, a web link in the browser.
  await pane.getByTestId('initiative-link').filter({ hasText: 'D-001' }).click();
  await pane.getByTestId('initiative-link').filter({ hasText: 'thread' }).click();
  await expect.poll(() => app.evaluate(() => [...globalThis.__companion.openedOutputs])).toEqual([join(folder, 'D-001.md'), 'https://example.com/legal']);

  // The attached session's PRD opens as its output, a note in Write.
  await outputs.getByTestId('initiative-link').click();
  await expect(page.getByTestId('mode-write')).toHaveAttribute('aria-selected', 'true');
});

