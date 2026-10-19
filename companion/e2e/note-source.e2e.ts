import { expect, test } from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { deliveriesFor, launch, type Launched, RESULTS, sock, tempDataDir } from './helpers';

let ctx: Launched;
let socketPath: string;

test.beforeEach(async () => {
  const dataDir = tempDataDir();
  socketPath = join(dataDir, 'companion.sock');
  ctx = await launch(dataDir);
  await expect.poll(() => existsSync(socketPath)).toBe(true);
});

test.afterEach(async () => {
  await ctx.app.close();
});

const FIRST = '# Findings\n\nJaehee\'s canvas sits apart, with each overlap marked.\n';
const RESTRUCTURED = '# Findings\n\nThe findings sit under eight themes.\n';
const TRIMMED = '# Findings\n\nEight themes, four for the board.\n';
const SAVED = '# Findings\n\nEight themes, then the Slack ask.\n';

function put(cwd: string, path: string, text: string): void {
  mkdirSync(dirname(join(cwd, path)), { recursive: true });
  writeFileSync(join(cwd, path), text);
}

test('a note opened from a file follows the file, and an edited one offers Reload before Send', async () => {
  const { page } = ctx;
  const cwd = mkdtempSync(join(tmpdir(), 'project-'));
  put(cwd, 'docs/findings.md', FIRST);
  await sock(socketPath, 'POST', '/sessions', { sessionId: 's1', cwd, title: 'pm-interview' });
  const body = page.getByTestId('draft-body');

  await sock(socketPath, 'POST', '/open', { sessionId: 's1', output: { path: 'docs/findings.md' } });
  await expect(body).toContainText('sits apart');

  // Claude rewrites the file while the note is open.
  put(cwd, 'docs/findings.md', RESTRUCTURED);
  await expect(body).toContainText('eight themes');

  // Opening it again shows the file as it is now.
  await page.getByTestId('mode-sketch').click();
  put(cwd, 'docs/findings.md', TRIMMED);
  await sock(socketPath, 'POST', '/open', { sessionId: 's1', output: { path: 'docs/findings.md' } });
  await expect(body).toContainText('four for the board');
  await expect(page.getByTestId('draft-source-changed')).toHaveCount(0);
  expect(await page.evaluate(() => window.__drafts.drafts.length), 'the open reuses the note').toBe(1);

  // Once main has saved the note, opening it again goes through main and still reads the file.
  await page.evaluate(() => window.__drafts.flush());
  await page.getByTestId('mode-sketch').click();
  put(cwd, 'docs/findings.md', SAVED);
  await sock(socketPath, 'POST', '/open', { sessionId: 's1', output: { path: 'docs/findings.md' } });
  await expect(body).toContainText('then the Slack ask');
  expect(await page.evaluate(() => window.__drafts.drafts.length)).toBe(1);
  put(cwd, 'docs/findings.md', TRIMMED);
  await expect(body).toContainText('four for the board');

  // An edited note keeps the person's words, says the file changed, and holds Send.
  await body.getByText('four for the board').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Mine.');
  await expect.poll(() => page.evaluate(() => window.__drafts.selected?.body)).toContain('Mine.');
  put(cwd, 'docs/findings.md', RESTRUCTURED);
  await expect(page.getByTestId('draft-source-changed')).toBeVisible();
  await expect(body).toContainText('Mine.');
  await page.screenshot({ path: join(RESULTS, 'note-source-changed.png') });
  await page.getByTestId('send').click();
  await expect(page.getByTestId('send-status')).toContainText('The file changed since you edited this note');
  expect(await deliveriesFor(socketPath, 's1')).toHaveLength(0);

  await page.getByTestId('draft-source-reload').click();
  await expect(page.getByTestId('draft-source-changed')).toHaveCount(0);
  await expect(body).toContainText('eight themes');
  await expect(body).not.toContainText('Mine.');
  await page.getByTestId('send').click();
  await expect.poll(async () => (await deliveriesFor(socketPath, 's1')).length).toBe(1);
});
