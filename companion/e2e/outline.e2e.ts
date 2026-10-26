import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { OutlineDocument } from '../src/protocol';
import { deliveriesFor, launchShown, openPanelFor, projectDir, RESULTS, ROOT, sock, type Launched } from './helpers';

let ctx: Launched;
let socketPath: string;

test.beforeEach(async () => {
  ({ ctx, socketPath } = await launchShown());
});

test.afterEach(async () => {
  await ctx.app.close();
});

const put = (cwd: string, rel: string, text: string) => {
  mkdirSync(dirname(join(cwd, rel)), { recursive: true });
  writeFileSync(join(cwd, rel), text);
};
const read = (cwd: string, rel: string) => {
  try {
    return readFileSync(join(cwd, rel), 'utf8');
  } catch {
    return '';
  }
};

/** Applies ops as Claude does through `agent-brief outline apply`. */
async function agent(sessionId: string, path: string, ops: unknown[]) {
  const route = `/sessions/${sessionId}/outline?path=${encodeURIComponent(path)}`;
  const { body: doc } = await sock<OutlineDocument>(socketPath, 'GET', route);
  const res = await sock(socketPath, 'POST', route, { version: doc.version, ops });
  expect(res.status).toBe(200);
}

const MEMO = `# Onboarding memo

Target: docs/memo.md
Kind: document

## Why change onboarding now ^s1
- New accounts wait a median 6 business days for the kickoff call. ^p1
    Cite: S1 · wait times · supports
- Self-serve cut time to first value from 9 to 4 days. ^p2
    Cite: S2 · p.3 · partly · pilot of 12 accounts only

## Sources
- S1 · CS ops dashboard export
    Checked: 2026-10-25
- S2 · Self-serve pilot readout
`;

const DIRECTED = MEMO.replace(
  'Kind: document\n',
  `Kind: document

## Direction · 2026-10-25 · proposed
Scope: regenerate
From: 3 comments on docs/memo.md
- The memo asks leadership to choose among three options
- Churn weighs as much as speed
Change: removed · section Recommendation
`,
);

/** A session in a fresh project, open in Write on its tab. */
async function session(page: Page, id: string, title: string): Promise<string> {
  const cwd = projectDir(title);
  mkdirSync(cwd, { recursive: true });
  await sock(socketPath, 'POST', '/sessions', { sessionId: id, cwd, title });
  await openPanelFor(socketPath, { sessionId: id, mode: 'write' });
  await expect(page.getByTestId('write')).toBeVisible();
  return cwd;
}

test('New → Outline makes an outline, and sections and points land in the file', async () => {
  const { page } = ctx;

  // On Unfiled there is no project to put the file in.
  await page.getByTestId('mode-write').click();
  await page.getByTestId('draft-new-menu').click();
  await page.getByTestId('new-menu-outline').click();
  await expect(page.getByTestId('outline-new-no-session')).toBeVisible();
  await page.keyboard.press('Escape');

  const cwd = await session(page, 'o1', 'Memo');
  await page.getByTestId('draft-new-menu').click();
  await page.getByTestId('new-menu-outline').click();
  await page.getByTestId('outline-new-title').fill('Onboarding memo');
  await page.getByTestId('outline-new-target').fill('docs/memo.md');
  await expect(page.getByTestId('outline-new-kind-document')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('outline-new-create').click();

  const editor = page.getByTestId('outline-editor');
  await expect(editor.getByTestId('outline-title')).toHaveValue('Onboarding memo');
  await expect(editor.getByTestId('outline-generate')).toHaveText(/Generate memo\.md/);
  await expect(page.getByTestId('draft-row').filter({ hasText: 'Onboarding memo' }).getByTestId('draft-outline-tag')).toBeVisible();
  await expect.poll(() => read(cwd, 'docs/memo.outline.md')).toContain('# Onboarding memo');

  // A section, then two points typed one after the other with Enter.
  await editor.getByTestId('outline-add-section').click();
  await page.keyboard.type('Why change onboarding now');
  await page.keyboard.press('Enter');
  const input = editor.getByTestId('outline-point-input');
  await expect(input.first()).toBeFocused();
  await page.keyboard.type('New accounts wait six days for kickoff');
  await page.keyboard.press('Enter');
  await expect(input.nth(1)).toBeFocused();
  await page.keyboard.type('Open: Can support absorb async questions?');
  await page.keyboard.press('Enter');
  await expect(input.nth(2)).toBeFocused();

  await expect
    .poll(() => read(cwd, 'docs/memo.outline.md'))
    .toBe(`# Onboarding memo

Target: docs/memo.md
Kind: document

## Why change onboarding now ^s1
- New accounts wait six days for kickoff ^p1
- Open: Can support absorb async questions? ^p2
`);
  await expect(editor.getByTestId('outline-point').nth(1).getByTestId('outline-marker')).toHaveAttribute('aria-pressed', 'true');

  // Backspace on the empty row drops it, and the file keeps two points.
  await page.keyboard.press('Backspace');
  await expect(editor.getByTestId('outline-pending')).toHaveCount(0);
  await expect(editor.getByTestId('outline-point')).toHaveCount(2);
  await page.screenshot({ path: join(RESULTS, 'outline-new.png') });
});

test("Claude's ops show at once, and a point being typed in keeps its words", async () => {
  const { page } = ctx;
  const cwd = await session(page, 'o2', 'Memo');
  put(cwd, 'docs/memo.outline.md', MEMO);
  await openPanelFor(socketPath, { sessionId: 'o2', output: { path: 'docs/memo.outline.md' } });

  const editor = page.getByTestId('outline-editor');
  const first = editor.locator('[data-point="p1"]').getByTestId('outline-point-input');
  await expect(first).toHaveValue('New accounts wait a median 6 business days for the kickoff call.');
  await expect(editor.locator('[data-point="p2"]').getByTestId('outline-cite')).toHaveText('S2 ~');
  await expect(editor.locator('[data-source="S1"]').getByTestId('outline-source-checked')).toHaveText('✓ Checked 2026-10-25');

  // You type into p1 without leaving it.
  await first.click();
  await page.keyboard.press('ControlOrMeta+ArrowDown');
  await page.keyboard.type(' Median, not mean.');

  // Claude adds a point, rewrites p1 and adds a guide to it.
  await agent('o2', 'docs/memo.outline.md', [
    { op: 'addPoint', section: 's1', text: 'Support load rises with self-serve.', after: 'p2' },
    { op: 'editPoint', id: 'p1', text: 'Claude rewrote this.', guide: 'state it as the baseline' },
  ]);
  await expect(editor.locator('[data-point="p3"]').getByTestId('outline-point-input')).toHaveValue('Support load rises with self-serve.');
  await expect(editor.locator('[data-point="p1"]').getByTestId('outline-guide')).toHaveText('Guide · state it as the baseline');
  await expect(first).toBeFocused();
  await expect(first).toHaveValue('New accounts wait a median 6 business days for the kickoff call. Median, not mean.');

  // Leaving the field writes your words over Claude's, and the guide stays.
  await page.keyboard.press('Tab');
  await expect.poll(() => read(cwd, 'docs/memo.outline.md')).toContain('- New accounts wait a median 6 business days for the kickoff call. Median, not mean. ^p1\n    Cite: S1 · wait times · supports\n    Guide: state it as the baseline\n');

  // A chip points at its source in the rail.
  await editor.locator('[data-point="p1"]').getByTestId('outline-cite').click();
  await expect(editor.locator('[data-source="S1"]')).toHaveClass(/\bon\b/);

  // ⌥↓ moves a point, and a cite added in the expander names a listed source.
  await editor.locator('[data-point="p3"]').getByTestId('outline-point-input').click();
  await page.keyboard.press('Alt+ArrowUp');
  await expect.poll(() => read(cwd, 'docs/memo.outline.md')).toMatch(/\^p1\n[\s\S]*\^p3\n[\s\S]*\^p2\n/);
  await editor.locator('[data-point="p3"]').getByTestId('outline-point-more').click();
  await editor.locator('[data-point="p3"]').getByTestId('outline-add-cite').selectOption('S2');
  await expect.poll(() => read(cwd, 'docs/memo.outline.md')).toContain('- Support load rises with self-serve. ^p3\n    Cite: S2\n');
  await page.screenshot({ path: join(RESULTS, 'outline-live.png') });
});

test('a proposed direction shows its banner, and Accept sends it and marks it accepted', async () => {
  const { page } = ctx;
  const cwd = await session(page, 'o3', 'Memo');
  put(cwd, 'docs/memo.outline.md', DIRECTED);
  await openPanelFor(socketPath, { sessionId: 'o3', output: { path: 'docs/memo.outline.md' } });

  const banner = page.getByTestId('outline-direction');
  await expect(banner).toContainText('Direction from 3 comments on docs/memo.md. Claude has not changed it yet.');
  await expect(banner.locator('.outline-direction-bullets li')).toHaveText(['The memo asks leadership to choose among three options', 'Churn weighs as much as speed']);
  await expect(banner.getByTestId('outline-direction-scope')).toHaveText('Scope · regenerate docs/memo.md from the outline');
  await expect(banner.locator('.outline-direction-changes li')).toHaveText(['removed · section Recommendation']);
  await expect(banner.getByTestId('outline-accept')).toHaveText('Accept and regenerate');
  await expect(banner.getByTestId('outline-edit-in-place')).toBeVisible();
  await page.screenshot({ path: join(RESULTS, 'outline-direction.png') });

  await banner.getByTestId('outline-accept').click();
  await expect
    .poll(async () => (await deliveriesFor(socketPath, 'o3')).map((d) => d.draft))
    .toEqual([
      expect.stringContaining(
        'Direction accepted for docs/memo.outline.md (outline-first). Revise docs/memo.md at scope regenerate from the updated outline, check it against the outline, then clear the direction.',
      ),
    ]);
  await expect.poll(() => read(cwd, 'docs/memo.outline.md')).toContain('## Direction · 2026-10-25 · accepted\nScope: regenerate\n');
});

test('a long point wraps, Enter adds a row, and ↑ ↓ leave a point only from its first or last line', async () => {
  const { page } = ctx;
  const cwd = await session(page, 'o5', 'Memo');
  const long = 'Self-serve onboarding cut the wait for a first call, and accounts started on their own schedule. '.repeat(4).trim();
  put(cwd, 'docs/memo.outline.md', MEMO.replace('Self-serve cut time to first value from 9 to 4 days.', long));
  await openPanelFor(socketPath, { sessionId: 'o5', output: { path: 'docs/memo.outline.md' } });

  const editor = page.getByTestId('outline-editor');
  const p1 = editor.locator('[data-point="p1"]').getByTestId('outline-point-input');
  const p2 = editor.locator('[data-point="p2"]').getByTestId('outline-point-input');
  await expect(p2).toHaveValue(long);
  expect((await p2.boundingBox())!.height).toBeGreaterThan(50);
  const caret = () => p2.evaluate((el: HTMLTextAreaElement) => el.selectionStart);

  // Inside the wrapped point, ↑ and ↓ move between its lines.
  await p2.click();
  await page.keyboard.press('ControlOrMeta+ArrowUp');
  await page.keyboard.press('ArrowDown');
  await expect(p2).toBeFocused();
  expect(await caret()).toBeGreaterThan(0);
  await page.keyboard.press('ControlOrMeta+ArrowDown');
  await page.keyboard.press('ArrowUp');
  await expect(p2).toBeFocused();
  expect(await caret()).toBeLessThan(long.length);

  // From its first line, ↑ goes to the row above. ↓ from there comes back to its start.
  await page.keyboard.press('ControlOrMeta+ArrowUp');
  await page.keyboard.press('ArrowUp');
  await expect(p1).toBeFocused();
  await page.keyboard.press('ControlOrMeta+ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(p2).toBeFocused();
  expect(await caret()).toBe(0);

  // Enter at the end adds a row without a line break, and Backspace on it comes back.
  await page.keyboard.press('ControlOrMeta+ArrowDown');
  await page.keyboard.press('Enter');
  await expect(editor.getByTestId('outline-pending').getByTestId('outline-point-input')).toBeFocused();
  await expect(p2).toHaveValue(long);
  await page.keyboard.press('Backspace');
  await expect(editor.getByTestId('outline-pending')).toHaveCount(0);
  await expect(p2).toBeFocused();
  expect(await caret()).toBe(long.length);

  // The guide wraps too, and Enter commits it.
  await editor.locator('[data-point="p2"]').getByTestId('outline-point-more').click();
  const guide = editor.locator('[data-point="p2"]').getByTestId('outline-edit-guide');
  expect(await guide.evaluate((el) => el.tagName)).toBe('TEXTAREA');
  await guide.click();
  await page.keyboard.type('Plain, with the numbers first');
  await page.keyboard.press('Enter');
  await expect(guide).not.toBeFocused();
  await expect.poll(() => read(cwd, 'docs/memo.outline.md')).toContain('    Guide: Plain, with the numbers first\n');
  await page.screenshot({ path: join(RESULTS, 'outline-wrap.png') });
});

test('the target tab turns on once Claude writes the target, and its note names the outline', async () => {
  const { page } = ctx;
  const cwd = await session(page, 'o6', 'Memo');
  put(cwd, 'docs/memo.outline.md', MEMO);
  await openPanelFor(socketPath, { sessionId: 'o6', output: { path: 'docs/memo.outline.md' } });
  const tab = page.getByTestId('outline-open-target');
  await expect(tab).toBeDisabled();

  // Claude writes the target, and the panel takes focus again.
  put(cwd, 'docs/memo.md', '# Onboarding memo\n\nNew accounts wait six days.\n');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(tab).toBeEnabled();

  // Claude writes the target and declares it as an output.
  rmSync(join(cwd, 'docs/memo.md'));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(tab).toBeDisabled();
  put(cwd, 'docs/memo.md', '# Onboarding memo\n\nNew accounts wait six days.\n');
  const now = Date.now();
  put(cwd, '.feedback/outputs/o6.json', JSON.stringify({
    version: 1,
    sessionId: 'o6',
    outputs: [{ ref: 'docs/memo.md', title: 'Onboarding memo', kind: 'markdown', tier: 'declared', status: 'drafting', origin: 'created', declaredAt: now, firstWriteAt: now, lastWriteAt: now, writes: 1 }],
  }));
  await expect(tab).toBeEnabled();

  // The target opens as a note, whose Send revises the outline first.
  await tab.click();
  await expect(page.getByTestId('draft-source')).toHaveText(
    'From docs/memo.md. Send folds your comments into docs/memo.outline.md first, and Claude proposes a direction there.',
  );
});

test('a direction with many changes shows four until Show more', async () => {
  const { page } = ctx;
  const cwd = await session(page, 'o7', 'Memo');
  const changes = Array.from({ length: 14 }, (_, i) => `Change: edited · point p${i + 1}`).join('\n');
  put(cwd, 'docs/memo.outline.md', DIRECTED.replace('Change: removed · section Recommendation', changes));
  await openPanelFor(socketPath, { sessionId: 'o7', output: { path: 'docs/memo.outline.md' } });

  const banner = page.getByTestId('outline-direction');
  const lines = banner.locator('.outline-direction-changes li');
  await expect(lines).toHaveCount(4);
  await expect(lines.first()).toHaveText('edited · point p1');
  const more = banner.getByTestId('outline-direction-more');
  await expect(more).toHaveText('Show 10 more');
  await more.click();
  await expect(lines).toHaveCount(14);
  await expect(more).toHaveText('Show fewer');
  await more.click();
  await expect(lines).toHaveCount(4);
});

test('the outline CLI makes, fills and shows an outline that Write opens', async () => {
  const { page } = ctx;
  const cwd = await session(page, 'o4', 'Pilot');
  const cli = (...args: string[]) =>
    execFileSync('node', [join(ROOT, 'bin/agent-brief.mjs'), 'outline', ...args], {
      cwd,
      env: { ...process.env, COMPANION_SOCKET: socketPath, CLAUDE_CODE_SESSION_ID: 'o4' },
    }).toString();

  expect(cli('new', 'Pilot memo', '--target', 'docs/pilot.md').split('\n')[0]).toBe('docs/pilot.outline.md');
  await expect(page.getByTestId('outline-editor')).toBeVisible();

  put(cwd, '.feedback/outline-ops.json', JSON.stringify([
    { op: 'addSource', title: 'Pilot readout', ref: 'docs/readout.md', label: 'readout' },
    { op: 'addSection', title: 'What the pilot showed', label: 'showed' },
    { op: 'addPoint', section: '@showed', text: 'First value came 5 days sooner.', cites: [{ source: '@readout', location: 'p.3' }] },
  ]));
  expect(cli('apply', 'docs/pilot.outline.md', '--ops', '.feedback/outline-ops.json')).toContain('applied 3 ops');
  expect(cli('show', 'docs/pilot.outline.md')).toContain('- First value came 5 days sooner. ^p1\n    Cite: S1 · p.3\n');
  expect(cli('list')).toContain('docs/pilot.outline.md');
  await expect(page.locator('[data-point="p1"]').getByTestId('outline-point-input')).toHaveValue('First value came 5 days sooner.');
});
