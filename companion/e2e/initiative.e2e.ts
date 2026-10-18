import { expect, test } from '@playwright/test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
  const brief = join(folder, 'Pricing brief.md');
  expect(readFileSync(brief, 'utf8')).toMatch(/^---\nagent_brief_id: "[0-9a-f]+"\n---\n# Pricing\n/);
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
