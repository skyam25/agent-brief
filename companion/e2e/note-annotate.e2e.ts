import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { NoteResponse } from '../src/protocol';
import { deliveriesFor, launch, type Launched, RESULTS, ROOT, showPanel, sock, tempDataDir } from './helpers';

const RECAP = [
  '# Interview recap',
  '',
  '## Block 1',
  '',
  'Walk me through a product you consider a success.',
  '',
  'What did you learn that changed what you built?',
].join('\n');

let ctx: Launched;
let socketPath: string;

/** Launches with `env`, files the recap under session s1, and opens it in Write. */
async function openRecap(env: Record<string, string> = {}): Promise<{ page: Page; cwd: string }> {
  const dataDir = tempDataDir();
  socketPath = join(dataDir, 'companion.sock');
  ctx = await launch(dataDir, env);
  await showPanel(ctx.app, ctx.page);
  await expect.poll(() => existsSync(socketPath)).toBe(true);
  const cwd = mkdtempSync(join(tmpdir(), 'project-'));
  await sock(socketPath, 'POST', '/sessions', { sessionId: 's1', cwd, title: 'pm-interview' });
  const note = await sock<NoteResponse>(socketPath, 'POST', '/notes', { sessionId: 's1', title: 'Interview recap', text: RECAP });
  await sock(socketPath, 'POST', '/open', { note: { id: note.body.draftId } });
  await expect(ctx.page.getByTestId('draft-title')).toHaveText('Interview recap');
  return { page: ctx.page, cwd };
}

/** Drags from a paragraph's first line to its last, as a person selects it. */
async function dragAcross(page: Page, text: string): Promise<void> {
  const box = (await page.getByTestId('draft-body').getByText(text).boundingBox())!;
  await page.mouse.move(box.x + 1, box.y + 6);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 });
  await page.mouse.move(box.x + box.width - 1, box.y + box.height - 6, { steps: 4 });
  await page.mouse.up();
}

test.afterEach(async () => {
  await ctx.app.close();
});

test('a selected passage takes a comment, shows highlighted, and Send hands Claude annotations.md', async () => {
  const { page } = await openRecap();
  await expect(page.getByTestId('note-comments')).toHaveCount(0);

  await page.getByTestId('draft-body').getByText('Walk me through').selectText();
  await expect(page.getByTestId('format-comment')).toBeVisible();
  await page.screenshot({ path: join(RESULTS, 'note-annotate-bar.png') });
  await page.getByTestId('format-comment').click();
  await expect(page.getByTestId('format-comment'), 'the bar closes once the comment is made').toBeHidden();
  await expect(page.getByTestId('note-comment')).toHaveCount(1);
  await expect(page.getByTestId('note-comment-quote')).toHaveText('Walk me through a product you consider a success.');
  await expect(page.getByTestId('note-comment-text')).toBeFocused();
  await page.keyboard.type('Ask for the metric up front.');
  await page.getByTestId('note-overall').fill('Shorten it for a 30 minute slot.');

  const highlight = page.getByTestId('draft-body').locator('.annot');
  await expect(highlight).toHaveText('Walk me through a product you consider a success.');
  await expect(page.getByTestId('draft-body').locator('sup.annot-badge')).toHaveText('1');
  expect(await page.evaluate(() => window.__drafts.selected?.body), 'the highlight stays out of the Markdown').toBe(RECAP);
  await page.screenshot({ path: join(RESULTS, 'note-annotate.png') });

  // Clicking the highlight puts its comment in focus.
  await page.getByTestId('note-overall').focus();
  await expect(page.getByTestId('note-comment')).not.toHaveClass(/active/);
  await highlight.click();
  await expect(page.getByTestId('note-comment')).toHaveClass(/active/);

  const noteId = await page.evaluate(() => window.__drafts.selected!.id);
  await page.getByTestId('send').click();
  await expect.poll(async () => (await deliveriesFor(socketPath, 's1')).length).toBe(1);
  const [delivery] = await deliveriesFor(socketPath, 's1');
  const rel = `.feedback/sketches/${delivery!.dir.split('/').at(-1)}`;
  expect(delivery!.draft).toBe(
    [
      `@${rel}/draft.md`,
      `@${rel}/annotations.md`,
      `Comments on the note “Interview recap” from Agent Brief, 1 comment on passages. Revise the note in place: run \`agent-brief note --id ${noteId}\` with the full new text, then \`agent-brief open --note ${noteId}\`, then say what changed.`,
    ].join('\n'),
  );

  // The note stays for Claude to revise, and its comments went out.
  await expect.poll(() => ctx.page.evaluate((id) => {
    const d = window.__drafts.get(id);
    return d ? { body: d.body, annotations: d.annotations ?? null } : null;
  }, noteId)).toEqual({ body: RECAP, annotations: null });
  expect(readFileSync(join(delivery!.dir, 'draft.md'), 'utf8')).toBe(RECAP);
  const md = readFileSync(join(delivery!.dir, 'annotations.md'), 'utf8');
  expect(md).toContain('# Comments on the note “Interview recap”');
  expect(md).toContain('## Overall\n\nShorten it for a 30 minute slot.');
  expect(md).toContain('## 1. “Walk me through a product you consider a success.”\n\nAsk for the metric up front.');
  expect(md).toContain('- Under heading: “Block 1”');
});

test('a comment whose words left the note says the text changed', async () => {
  const { page } = await openRecap();
  await page.getByTestId('draft-body').getByText('What did you learn').selectText();
  await page.getByTestId('format-comment').click();
  await expect(page.getByTestId('note-comment-missing')).toHaveCount(0);

  await page.getByTestId('draft-body').getByText('What did you learn').click();
  await page.keyboard.press('End');
  await page.keyboard.press('Backspace');
  await expect(page.getByTestId('note-comment-missing')).toHaveText('Text changed');
  await expect(page.getByTestId('draft-body').locator('.annot')).toHaveCount(0);
});

test('Talk and annotate: selecting while talking makes a comment, and the words land on it', async () => {
  const speech = join(ROOT, 'e2e/fixtures/speech.wav');
  test.skip(!existsSync(speech), 'speech fixture missing');
  test.setTimeout(120_000);
  const { page } = await openRecap({ COMPANION_TEST_AUDIO: speech });

  await expect(page.getByTestId('mic')).toContainText('Talk and annotate');
  await page.getByTestId('mic').click();
  await expect(page.getByTestId('note-comments-empty')).toContainText('Select a passage');

  await dragAcross(page, 'Walk me through');
  await expect(page.getByTestId('note-comment')).toHaveCount(1);
  await expect(page.getByTestId('note-comment')).toHaveClass(/listening/);
  await page.waitForTimeout(5000);

  // Send right after Stop still waits for the last words.
  await page.getByTestId('mic').click();
  await page.getByTestId('send').click();
  await expect.poll(async () => (await deliveriesFor(socketPath, 's1')).length, { timeout: 60_000 }).toBe(1);
  const [delivery] = await deliveriesFor(socketPath, 's1');
  expect(readFileSync(join(delivery!.dir, 'annotations.md'), 'utf8')).toMatch(/## 1\. “Walk me through[^\n]*\n\n[^\n]*pricing table/i);
  expect(readFileSync(join(delivery!.dir, 'draft.md'), 'utf8'), 'speech never lands in the note itself').toBe(RECAP);
});

test('a commented note linked to a board survives a Send from Sketch, for Claude to revise', async () => {
  const { page } = await openRecap();
  await page.getByTestId('draft-body').getByText('Walk me through').selectText();
  await page.getByTestId('format-comment').click();
  await page.keyboard.type('Ask for the metric.');
  const noteId = await page.evaluate(() => window.__drafts.selected!.id);
  const board = await page.evaluate(() => window.__board.board);
  await page.evaluate(([id, b]) => window.__drafts.link(id!, b!), [noteId, board]);
  await page.getByTestId('mode-sketch').click();

  await page.getByTestId('send').click();
  await expect.poll(async () => (await deliveriesFor(socketPath, 's1')).length).toBe(1);
  const [delivery] = await deliveriesFor(socketPath, 's1');
  expect(delivery!.draft).toContain(`agent-brief note --id ${noteId}`);
  expect(delivery!.draft).toContain('sketch.png');
  await expect.poll(() => page.evaluate((id) => {
    const d = window.__drafts.get(id);
    return d ? { body: d.body, annotations: d.annotations ?? null } : null;
  }, noteId)).toEqual({ body: RECAP, annotations: null });
});

test('opening an ended session\'s note shows its tab, not the live target\'s', async () => {
  const { page, cwd } = await openRecap();
  const noteId = await page.evaluate(() => window.__drafts.selected!.id);
  await sock(socketPath, 'POST', '/sessions', { sessionId: 's2', cwd, title: 'other' });
  const other = await sock<NoteResponse>(socketPath, 'POST', '/notes', { sessionId: 's2', title: 'Other note', text: 'Other text' });
  await sock(socketPath, 'POST', '/open', { note: { id: other.body.draftId } });
  await expect(page.getByTestId('draft-title')).toHaveText('Other note');
  await sock(socketPath, 'DELETE', '/sessions/s1');

  const res = await sock<{ opened?: string; targetSessionId?: string }>(socketPath, 'POST', '/open', { note: { id: noteId } });
  expect(res.body.opened).toBe('note');
  expect(res.body.targetSessionId).toBeUndefined();
  await expect(page.getByTestId('draft-title')).toHaveText('Interview recap');
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => window.__drafts.selected?.body)).toBe(RECAP);
});
