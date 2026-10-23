import { expect, test } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { backend, launch, sceneElements, showPanel, tempDataDir, type Launched } from './helpers';

test('board comments survive a restart, including an immediate quit after typing', async () => {
  const dataDir = tempDataDir();
  let ctx: Launched = await launch(dataDir);
  try {
    await showPanel(ctx.app, ctx.page);
    await ctx.page.getByTestId('comment-tool').click();
    await ctx.page.getByTestId('board-overall').fill('Remember these dictated words');
    const canvas = ctx.page.locator('canvas.excalidraw__canvas.interactive');
    await canvas.click({ position: { x: 300, y: 260 } });
    await ctx.page.getByTestId('board-comment-text').fill('Keep this pin after restart');
    const board = await ctx.page.evaluate(() => window.__board.board);
    await ctx.app.close();
    const path = join(dataDir, 'boards', `${board}.comments.json`);
    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
      overall: 'Remember these dictated words', pins: [{ text: 'Keep this pin after restart' }],
    });
    ctx = await launch(dataDir);
    await showPanel(ctx.app, ctx.page);
    await expect(ctx.page.getByTestId('board-overall')).toHaveValue('Remember these dictated words');
    await expect(ctx.page.getByTestId('board-comment-text')).toHaveValue('Keep this pin after restart');
  } finally { await ctx.app.close(); }
});

test('selecting a vanished session rejects instead of silently keeping the old target', async () => {
  const ctx = await launch(tempDataDir());
  try {
    const error = await ctx.page.evaluate(async () => {
      try { await window.companion.setTarget('vanished'); return ''; }
      catch (err) { return (err as Error).message; }
    });
    expect(error).toContain('unknown session vanished');
  } finally { await ctx.app.close(); }
});

test('Send completion clears the original canvas after switching and preserves newer edits', async () => {
  const ctx = await launch(tempDataDir());
  try {
    await showPanel(ctx.app, ctx.page);
    await backend(ctx.app, 'draw', 'current', { elements: [{ type: 'rectangle', id: 'sent', x: 0, y: 0, width: 100, height: 100 }] });
    await ctx.page.evaluate(async () => {
      const board = window.__board;
      const sent = await board.payload();
      await board.createBoard('other');
      board.setNotes('Never sent');
      await board.finishSend(sent, true);
      if (board.board !== 'other' || board.notes !== 'Never sent') throw new Error('Send modified the current board');
      await board.switchTo(sent.boardName);
    });
    expect((await sceneElements(ctx.page)).filter((e) => !e.isDeleted)).toHaveLength(0);
    await backend(ctx.app, 'draw', 'current', { elements: [{ type: 'rectangle', id: 'new', x: 0, y: 0, width: 100, height: 100 }] });
    await ctx.page.evaluate(async () => {
      const board = window.__board;
      const sent = await board.payload();
      board.setNotes('Typed during Send');
      await board.finishSend(sent, true);
    });
    expect((await sceneElements(ctx.page)).filter((e) => !e.isDeleted).map((e) => e.id)).toContain('new');
    expect(await ctx.page.evaluate(() => window.__board.notes)).toBe('Typed during Send');
  } finally { await ctx.app.close(); }
});
