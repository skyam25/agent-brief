import { expect, test, type Page } from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DeliveriesResponse } from '../src/protocol';
import { draftBody, launch, type Launched, RESULTS, sendToSession, showPanel, sock, tempDataDir } from './helpers';

let ctx: Launched;
let socketPath: string;
let dataDir: string;

test.beforeEach(async () => {
  dataDir = tempDataDir();
  socketPath = join(dataDir, 'companion.sock');
  ctx = await launch(dataDir);
  await showPanel(ctx.app, ctx.page);
  await expect.poll(() => existsSync(socketPath)).toBe(true);
  await ctx.page.getByTestId('mode-write').click();
});

test.afterEach(async () => {
  await ctx.app.close();
});

const editor = (page: Page) => page.getByTestId('draft-body');
const draftsOnDisk = () =>
  readdirSync(join(dataDir, 'drafts'))
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(dataDir, 'drafts', f), 'utf8')));

/** Starts typing at the end of the open draft. */
async function typeAtEnd(page: Page, text: string): Promise<void> {
  await editor(page).click();
  await page.keyboard.press('Meta+ArrowDown');

  // ProseMirror reads a moved caret a moment later. A key sent before then lands at the old spot.
  await page.waitForTimeout(100);
  await page.keyboard.type(text);
}

/**
 * Pastes a small PNG into the editor. Electron's clipboard is off limits in
 * tests, so this builds the file in the page and fires a synthetic paste.
 */
async function pastePng(page: Page, width = 120, height = 80): Promise<void> {
  await page.evaluate(
    async ({ width, height }) => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const g = canvas.getContext('2d')!;
      g.fillStyle = '#3b82f6';
      g.fillRect(0, 0, width, height);
      g.fillStyle = '#fbbf24';
      g.fillRect(width / 4, height / 4, width / 2, height / 2);
      const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), 'image/png'));
      const data = new DataTransfer();
      data.items.add(new File([blob], 'shot.png', { type: 'image/png' }));
      const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data });
      document.querySelector('[data-testid="draft-body"]')!.dispatchEvent(event);
    },
    { width, height },
  );
}

/** Inserts a block through the slash menu. */
async function slash(page: Page, query: string, title: string): Promise<void> {
  await page.keyboard.type(`/${query}`);
  await expect(page.getByTestId('slash-menu')).toBeVisible();
  await page.getByTestId('slash-item').filter({ hasText: title }).first().click();
  await expect(page.getByTestId('slash-menu')).toHaveCount(0);
}

test('Markdown shortcuts make lists, tasks and headings, saved as Markdown', async () => {
  const { page } = ctx;
  await editor(page).click();
  await page.keyboard.type('# Plan\n');
  await page.keyboard.type('- one\ntwo\n\n');
  await page.keyboard.type('1. first\nsecond\n\n');
  await page.keyboard.type('[] check the login');

  await expect(editor(page).locator('h1')).toHaveText('Plan');
  await expect(editor(page).locator('ul:not([data-type="taskList"]) > li')).toHaveText(['one', 'two']);
  await expect(editor(page).locator('ol > li')).toHaveText(['first', 'second']);
  const task = editor(page).locator('ul[data-type="taskList"] > li');
  await expect(task.locator(':scope > div')).toHaveText(['check the login']);
  await expect(task.locator('input[type="checkbox"]')).not.toBeChecked();

  const markdown = '# Plan\n\n- one\n- two\n\n1. first\n2. second\n\n- [ ] check the login';
  await expect.poll(() => draftBody(page)).toBe(markdown);
  await expect.poll(() => draftsOnDisk().map((d) => d.body)).toEqual([markdown]);
});

test('nested numbered lists go 1, a, i, and a right-click sets the format of one list', async () => {
  const { page } = ctx;
  await editor(page).click();
  await page.keyboard.type('1. one\ntwo');
  await page.keyboard.press('Tab');
  await page.keyboard.type('\nthree');
  await page.keyboard.press('Tab');

  const styles = () =>
    editor(page)
      .locator('ol')
      .evaluateAll((lists) => lists.map((l) => getComputedStyle(l).listStyleType));
  await expect.poll(styles).toEqual(['decimal', 'lower-alpha', 'lower-roman']);
  await expect.poll(() => draftBody(page)).toBe('1. one\n   a. two\n      i. three');

  const three = editor(page).locator('li', { hasText: /^three$/ }).locator('p');
  const menu = page.getByTestId('list-format-menu');
  await three.click({ button: 'right' });
  await expect(menu).toBeVisible();
  await expect(menu.locator('[aria-checked="true"]')).toHaveAttribute('data-format', 'i');
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(editor(page)).toBeVisible();

  await three.click({ button: 'right' });
  await menu.locator('[data-format="1"]').click();
  await expect(menu).toHaveCount(0);
  await expect.poll(styles).toEqual(['decimal', 'lower-alpha', 'decimal']);
  await expect.poll(() => draftBody(page)).toBe('1. one\n   a. two\n      1. three');
  await expect.poll(() => draftsOnDisk().map((d) => d.body)).toEqual(['1. one\n   a. two\n      1. three']);
});

test('⌘B bolds a selection, and the format bar shows while text is selected', async () => {
  const { page } = ctx;
  await editor(page).click();
  await page.keyboard.type('plain then loud');
  await expect(page.getByTestId('format-bar')).toBeHidden();

  // ProseMirror reads a burst of typed keys a moment later. A caret key sent before then is lost.
  await page.waitForTimeout(100);
  for (let i = 0; i < 4; i++) await page.keyboard.press('Shift+ArrowLeft');
  await expect(page.getByTestId('format-bar')).toBeVisible();
  await expect(page.getByTestId('format-bold')).toHaveAttribute('aria-pressed', 'false');

  await page.keyboard.press('Meta+B');
  await expect(editor(page).locator('strong')).toHaveText('loud');
  await expect(page.getByTestId('format-bold')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => draftBody(page)).toBe('plain then **loud**');
});

test('/table inserts a table that grows by row and column, saved as a GFM table', async () => {
  const { page } = ctx;
  await editor(page).click();
  await slash(page, 'table', 'Table');
  const table = editor(page).locator('table');
  await expect(table.locator('tr')).toHaveCount(3);
  await expect(table.locator('tr').first().locator('th')).toHaveCount(3);

  await page.keyboard.type('Name');
  await table.locator('tr').nth(1).locator('td').first().click();
  await page.keyboard.type('Ada');
  await expect(page.getByTestId('table-menu')).toBeVisible();
  await page.getByTestId('table-row-below').click();
  await page.getByTestId('table-col-right').click();
  await expect(table.locator('tr')).toHaveCount(4);
  await expect(table.locator('tr').first().locator('th')).toHaveCount(4);

  await expect
    .poll(async () => (await draftBody(page)).split('\n').filter((l) => l.startsWith('|')).length, { message: 'header, rule and three rows' })
    .toBe(5);
  const lines = (await draftBody(page)).split('\n');
  expect(lines[0]).toMatch(/^\|\s*Name\s*\|(\s*\|){3}$/);
  expect(lines[1]).toMatch(/^\|(\s*:?-{3,}:?\s*\|){4}$/);
  expect(lines[2]).toMatch(/^\|\s*Ada\s*\|(\s*\|){3}$/);
});

test('a pasted picture becomes an attachment and goes out as a bundle file', async () => {
  const { page } = ctx;
  const cwd = mkdtempSync(join(tmpdir(), 'project-'));
  await sock(socketPath, 'POST', '/sessions', { sessionId: 's1', cwd, title: 'Login work' });
  await editor(page).click();
  await page.keyboard.type('The header overlaps here\n');
  await pastePng(page);

  await expect(page.getByTestId('draft-image')).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => Object.keys((window as any).__drafts.selected.attachments ?? {}).length)).toBe(1);
  const [id, data] = await page.evaluate(() => Object.entries((window as any).__drafts.selected.attachments)[0] as [string, string]);
  expect(id).toMatch(/^[a-z0-9]{6,24}$/);
  expect(data).toMatch(/^data:image\/png;base64,/);
  await expect.poll(() => draftBody(page)).toBe(`The header overlaps here\n\n![](att:${id})`);
  await expect.poll(() => draftsOnDisk()[0]?.attachments).toEqual({ [id]: data });

  await sendToSession(page, 'Login work');
  await expect.poll(() => ctx.app.evaluate(() => (globalThis as any).__companion.panel.isVisible())).toBe(false);
  const [d] = (await sock<DeliveriesResponse>(socketPath, 'GET', '/deliveries?session=s1&wait=0')).body.deliveries;
  const line = `@.feedback/sketches/${d.id}/images/${id}.png`;
  expect(readdirSync(join(d.dir, 'images'))).toEqual([`${id}.png`]);
  expect(readFileSync(join(d.dir, 'images', `${id}.png`))).toEqual(Buffer.from(data.split(',')[1], 'base64'));
  const draftMd = readFileSync(join(d.dir, 'draft.md'), 'utf8');
  for (const text of [d.draft, draftMd]) {
    expect(text).toBe(`The header overlaps here\n\n${line}`);
    expect(text).not.toContain('att:');
  }
});

test('the editor shows a heading, bullets, a table and a picture together', async () => {
  const { page } = ctx;
  await editor(page).click();
  await page.keyboard.type('# Checkout polish\n');
  await page.keyboard.type('- Tighten the header spacing\nMatch the button **colours** to the brand\n\n');
  await slash(page, 'table', 'Table');
  // Tab moves cell to cell. In the last cell it would add a row.
  const cells = ['Screen', 'Issue', 'Owner', 'Cart', 'Totals wrap', 'Ada', 'Pay', 'Button too low', 'Lin'];
  for (const [i, cell] of cells.entries()) {
    await page.keyboard.type(cell);
    if (i < cells.length - 1) await page.keyboard.press('Tab');
  }
  await typeAtEnd(page, 'Where it breaks:');
  await page.keyboard.press('Enter');
  await pastePng(page, 320, 180);
  await expect(page.getByTestId('draft-image')).toHaveCount(1);
  await page.keyboard.type('Fix this before the release.');

  await expect(editor(page).locator('h1')).toHaveText('Checkout polish');
  await expect(editor(page).locator('ul > li')).toHaveCount(2);
  await expect(editor(page).locator('table tr')).toHaveCount(3);
  await expect(editor(page).locator('strong')).toHaveText('colours');
  const body = await draftBody(page);
  expect(body).toContain('**colours**');
  expect(body).toMatch(/\n\n\| Screen +\| Issue +\| Owner +\|\n/);
  expect(body).not.toMatch(/\n{3}/);

  // Typing after a paste goes below the picture and keeps it.
  expect(body).toMatch(/Where it breaks:\n\n!\[\]\(att:[a-z0-9]+\)\n\nFix this before the release\.$/);
  // The list shows the note as plain words, without Markdown markers.
  const row = page.getByTestId('draft-row').first();
  await expect(row.locator('.title')).toHaveText('Checkout polish');
  await expect(row.locator('.preview')).toContainText('Tighten the header spacing');
  await expect(row.locator('.preview')).not.toContainText('- ');
  await row.hover();
  await page.screenshot({ path: join(RESULTS, 'rich-editor.png') });
});

test('a plain-text draft from before the editor opens as paragraphs and stays as written', async () => {
  await ctx.app.close();
  const drafts = join(dataDir, 'drafts');
  mkdirSync(drafts, { recursive: true });
  const old = { id: 'old-note', body: 'First line\nsecond line', status: 'note', rank: 0, createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000 };
  writeFileSync(join(drafts, 'old-note.json'), JSON.stringify(old));

  ctx = await launch(dataDir);
  const { app, page } = ctx;
  await showPanel(app, page);
  await page.getByTestId('mode-write').click();
  const row = page.getByTestId('draft-row').filter({ hasText: 'First line' });
  await expect(row).toHaveCount(1);
  await expect(row.locator('.title')).toHaveText('First line');
  await row.click();
  await expect(editor(page)).toContainText('First line');
  await expect(editor(page)).toContainText('second line');

  // Opening a note is no edit, so it keeps its text and its place in the list.
  await page.waitForTimeout(500);
  const [onDisk] = draftsOnDisk();
  expect(onDisk).toMatchObject({ body: old.body, updatedAt: old.updatedAt });
});
