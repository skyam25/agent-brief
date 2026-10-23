import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { BoardStore } from '../main/store';
import type { BoardComments } from '../shared/board-comments';
import { BoardCommentsStore } from './board-comments';

afterEach(() => vi.useRealTimers());

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'comments-'));
  const disk = new BoardStore(dir);
  disk.create('board');
  const host = {
    listBoardComments: async () => disk.listComments(),
    saveBoardComments: vi.fn(async (board: string, comments: BoardComments) => disk.saveComments(board, comments)),
  };
  const comments = new BoardCommentsStore(host);
  return { dir, disk, host, comments };
}

it('restores pins and dictated overall text after restart and follows board rename and deletion', async () => {
  const { dir, disk, host, comments } = setup();
  const id = comments.add('board', { x: 1, y: 2 })!;
  comments.edit('board', id, 'Keep this feedback');
  comments.setOverall('board', 'Spoken words');
  await comments.flush();
  const restarted = new BoardCommentsStore({ ...host, listBoardComments: async () => new BoardStore(dir).listComments() });
  await restarted.load();
  expect(restarted.of('board')).toEqual(comments.of('board'));
  expect(disk.isEmpty('board')).toBe(false);
  disk.rename('board', 'renamed');
  restarted.rename('board', 'renamed');
  await restarted.flush();
  expect(disk.listComments()).toEqual({ renamed: comments.of('board') });
  for (const file of disk.files('renamed')) rmSync(file);
  restarted.forget('renamed');
  await restarted.flush();
  expect(disk.listComments()).toEqual({});
});

it('persists Send cleanup without deleting newer pins or words', async () => {
  const { disk, comments } = setup();
  const first = comments.add('board', { x: 0, y: 0 })!;
  comments.edit('board', first, 'sent');
  comments.setOverall('board', 'sent overall');
  const sent = comments.of('board');
  comments.edit('board', first, 'edited while sending');
  comments.add('board', { x: 10, y: 10 });
  comments.setOverall('board', 'new overall');
  comments.consume('board', sent);
  await comments.flush();
  expect(disk.listComments().board.pins).toHaveLength(2);
  expect(disk.listComments().board.overall).toBe('new overall');
  comments.consume('board', comments.of('board'));
  await comments.flush();
  expect(disk.listComments()).toEqual({});
});

it('reports a failed save and retries it without losing the comments', async () => {
  vi.useFakeTimers();
  const { disk, host, comments } = setup();
  host.saveBoardComments.mockRejectedValueOnce(new Error('disk full'));
  comments.setOverall('board', 'keep me');
  await vi.advanceTimersByTimeAsync(400);
  expect(comments.saveError).toBe('disk full');
  await comments.flush();
  expect(comments.saveError).toBeUndefined();
  expect(disk.listComments().board.overall).toBe('keep me');
});

it('applies a delayed Send to a renamed board and ignores one deleted during delivery', async () => {
  const { disk, comments } = setup();
  comments.setOverall('board', 'sent');
  const sent = comments.of('board');
  await comments.flush();
  disk.rename('board', 'renamed');
  comments.rename('board', 'renamed');
  comments.setOverall('renamed', 'new words');
  comments.consume('board', sent);
  await comments.flush();
  expect(disk.listComments()).toEqual({ renamed: { overall: 'new words', pins: [] } });
  const later = comments.of('renamed');
  for (const file of disk.files('renamed')) rmSync(file);
  comments.forget('renamed');
  comments.consume('renamed', later);
  await comments.flush();
  expect(disk.listComments()).toEqual({});
});
