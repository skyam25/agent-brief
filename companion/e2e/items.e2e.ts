import { expect, test } from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { SessionInfo } from '../src/protocol';
import { deliveriesFor, launch, type Launched, RESULTS, showPanel, sock, tempDataDir } from './helpers';

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

const session = async (id: string) => (await sock<SessionInfo>(socketPath, 'GET', `/sessions/${id}`)).body;
const deliveries = (id: string) => deliveriesFor(socketPath, id);

const ITEMS = `# Items · checkout review

- [x] #1 Pay button above the fold
      Claude: done · moved into the first screen
- [ ] #2 Sidebar rows too tight
      Claude: 44px rows with 12px gaps, or 40px with 8px to fit six rows?
`;

test('Items mode tracks a session, shows its file, and sends decisions into it', async () => {
  const { app, page } = ctx;
  const cwd = mkdtempSync(join(tmpdir(), 'project-'));
  await sock(socketPath, 'POST', '/sessions', { sessionId: 's1', cwd, title: 'Checkout' });
  await sock(socketPath, 'POST', '/open', { sessionId: 's1' });
  await showPanel(app, page);
  await page.getByTestId('mode-items').click();

  // Tracking starts off; the switch turns it on for the session.
  const toggle = page.getByTestId('track-toggle');
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await toggle.click();
  await expect.poll(async () => (await session('s1')).trackItems).toBe(true);
  const itemsPath = (await session('s1')).itemsPath!;
  expect(itemsPath.endsWith(join('.feedback', 'items', 's1.md'))).toBe(true);
  const briefs = await page.evaluate(() => window.companion.listBriefs());
  expect(briefs.find((b) => b.sessionId === 's1')).toMatchObject({ trackItems: true });
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByText('No items yet.', { exact: false })).toBeVisible();

  // Claude writes the file; the view picks it up.
  mkdirSync(dirname(itemsPath), { recursive: true });
  writeFileSync(itemsPath, ITEMS);
  await expect(page.getByTestId('item-1')).toContainText('Pay button above the fold');
  await expect(page.getByTestId('item-2')).toContainText('Sidebar rows too tight');
  await expect(page.getByTestId('item-2').getByTestId('item-waiting')).toBeVisible();
  await expect(page.getByTestId('item-1').getByTestId('item-waiting')).toHaveCount(0);
  await expect(page.getByTestId('decision-1')).toHaveCount(0);
  await expect(page.getByTestId('items-count')).toHaveText('1 open · 1 done');

  // Send with nothing decided says so and sends nothing.
  await page.getByTestId('send').click();
  await expect(page.getByTestId('send-status')).toHaveText('Decide something first.');
  expect(await deliveries('s1')).toHaveLength(0);

  await page.getByTestId('decision-2').fill('44 / 12');
  await page.screenshot({ path: join(RESULTS, 'items-mode.png') });
  await page.getByTestId('send').click();
  await expect
    .poll(async () => (await deliveries('s1')).some((d) => d.draft.includes('#2') && d.draft.includes('44 / 12')))
    .toBe(true);
  expect(readFileSync(itemsPath, 'utf8')).toBe(`${ITEMS}      You: 44 / 12\n`);

  // Shown again from the hotkey, the panel has no target until the tab is picked. Items mode stays.
  await showPanel(app, page);
  await page.getByTestId('brief-tab').filter({ hasText: 'Checkout' }).getByRole('tab').click();
  await expect(page.getByTestId('mode-items')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('decision-2')).toHaveValue('');
  await expect(page.getByTestId('item-2').locator('.item-line.you')).toHaveText('You44 / 12');

  // Turning tracking off drops the path.
  await page.getByTestId('track-toggle').click();
  await expect.poll(async () => (await session('s1')).trackItems ?? false).toBe(false);
  expect((await session('s1')).itemsPath).toBeUndefined();
});

const WITH_OUTPUTS = `# Items · checkout review

- [ ] #2 Sidebar rows too tight
      Claude: 44px rows with 12px gaps, or 40px with 8px?
      Out: src/Checkout.tsx
      Out: src/missing.tsx
- [x] #1 Pay button above the fold
      Claude: done · moved into the first screen
      Out: mocks/checkout-v2.png
`;

test("Items mode links each item's Out files and opens them inside the project only", async () => {
  const { app, page } = ctx;
  const cwd = mkdtempSync(join(tmpdir(), 'project-'));
  for (const file of ['src/Checkout.tsx', 'mocks/checkout-v2.png']) {
    mkdirSync(dirname(join(cwd, file)), { recursive: true });
    writeFileSync(join(cwd, file), 'x');
  }
  await sock(socketPath, 'POST', '/sessions', { sessionId: 's1', cwd, title: 'Checkout' });
  await sock(socketPath, 'POST', '/open', { sessionId: 's1' });
  await showPanel(app, page);
  await page.getByTestId('mode-items').click();
  await page.getByTestId('track-toggle').click();
  await expect.poll(async () => (await session('s1')).trackItems).toBe(true);
  const itemsPath = (await session('s1')).itemsPath!;
  mkdirSync(dirname(itemsPath), { recursive: true });
  writeFileSync(itemsPath, WITH_OUTPUTS);

  // Out lines become links, not notes. The open item reads as work in progress.
  const open = page.getByTestId('output-2-0');
  await expect(open).toHaveText('src/Checkout.tsx');
  await expect(open).toHaveAttribute('title', 'src/Checkout.tsx');
  await expect(page.getByTestId('output-2-1')).toHaveText('src/missing.tsx');
  await expect(page.getByTestId('outputs-2')).toContainText('Working on');
  await expect(page.getByTestId('output-1-0')).toHaveText('mocks/checkout-v2.png');
  await expect(page.getByTestId('outputs-1')).toContainText('Files');
  await expect(page.getByTestId('item-2').locator('.item-note')).toHaveCount(0);
  await page.screenshot({ path: join(RESULTS, 'items-outputs.png') });

  const opened = () => app.evaluate(() => [...globalThis.__companion.openedOutputs]);
  await open.click();
  await expect.poll(opened).toEqual([join(cwd, 'src', 'Checkout.tsx')]);
  await page.getByTestId('output-1-0').click();
  await expect.poll(opened).toEqual([join(cwd, 'src', 'Checkout.tsx'), join(cwd, 'mocks', 'checkout-v2.png')]);

  // A file Claude has not written yet says so and opens nothing.
  await page.getByTestId('output-2-1').click();
  await expect(page.getByTestId('send-status')).toHaveText('Could not open that file: src/missing.tsx does not exist yet');
  expect(await opened()).toHaveLength(2);

  // A path outside the project is refused even when it exists.
  const outside = await page.evaluate(() => window.companion.openItemOutput('s1', '../').catch((e: Error) => e.message));
  expect(outside).toContain('is outside the project');
  expect(await opened()).toHaveLength(2);

  // A decision still lands after the Out lines, the rest of the file untouched.
  await page.getByTestId('decision-2').fill('44 / 12');
  await page.getByTestId('send').click();
  await expect.poll(async () => (await deliveries('s1')).some((d) => d.draft.includes('44 / 12'))).toBe(true);
  expect(readFileSync(itemsPath, 'utf8')).toBe(
    WITH_OUTPUTS.replace('      Out: src/missing.tsx\n', '      Out: src/missing.tsx\n      You: 44 / 12\n'),
  );
  await expect(page.getByTestId('output-2-0')).toBeVisible();
});

test('Items needs a session tab, and says how to get one when the session goes', async () => {
  const { app, page } = ctx;
  await showPanel(app, page);
  // The Notes tab has no Items, so ⌘3 does nothing there.
  await page.keyboard.press('Meta+3');
  await expect(page.getByTestId('mode-items')).toHaveCount(0);
  await expect(page.getByTestId('mode-sketch')).toHaveAttribute('aria-selected', 'true');

  // Shown again from the hotkey, the panel has no target. Items stays open and says how to get one.
  await sock(socketPath, 'POST', '/sessions', { sessionId: 's1', cwd: mkdtempSync(join(tmpdir(), 'project-')), title: 'Checkout' });
  await sock(socketPath, 'POST', '/open', { sessionId: 's1' });
  await page.getByTestId('mode-items').click();
  await app.evaluate(() => globalThis.__companion.toggle());
  await showPanel(app, page);
  await expect(page.getByTestId('notes-tab')).toHaveAttribute('aria-current', 'true');
  await expect(page.getByTestId('mode-items')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('items-no-session')).toHaveText(
    'Open the panel from a Claude Code session (/sketch or /write) to track its items.',
  );
  await page.getByTestId('send').click();
  await expect(page.getByTestId('send-status')).toHaveText("Open a session's items first.");
  await expect(page.getByTestId('send-chooser')).toHaveCount(0);
});
