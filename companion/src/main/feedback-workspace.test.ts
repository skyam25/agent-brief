import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { DrawRequest, ReadResponse, Skeleton } from '../protocol';
import { tempDir } from '../server/testkit';
import { FeedbackStore } from './feedback';
import { FeedbackWorkspaces } from './feedback-workspace';
import { BoardStore } from './store';

/** Board work as the renderer does it, kept as the skeletons each board was given. */
function fakeBoards() {
  const scenes = new Map<string, Skeleton[]>();
  const read = vi.fn(async (board: string): Promise<ReadResponse> => {
    const els = scenes.get(board) ?? [];
    const right = Math.max(0, ...els.map((e) => (e.x ?? 0) + (e.width ?? 0)));
    const bottom = Math.max(0, ...els.map((e) => (e.y ?? 0) + (e.height ?? 0)));
    return { board, elements: els.map((e, i) => ({ id: String(i), by: 'claude', x: 0, y: 0, width: 0, height: 0, ...e, type: e.type })) as ReadResponse['elements'], bounds: { x: 0, y: 0, width: right, height: bottom } };
  });
  const draw = vi.fn(async (board: string, req: DrawRequest) => {
    scenes.set(board, [...(scenes.get(board) ?? []), ...req.elements]);
    return { ids: req.elements.map((_, i) => String(i)), batchId: 'b' };
  });
  const png = vi.fn(async () => Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return { scenes, read, draw, png };
}

function setup() {
  const root = tempDir();
  const data = tempDir();
  mkdirSync(join(root, 'prototype'));
  writeFileSync(join(root, 'prototype/checkout.html'), '<div id="filters"></div>');
  const feedback = new FeedbackStore(undefined, () => new Date(2026, 9, 18));
  const store = new BoardStore(data);
  const boards = fakeBoards();
  const workspaces = new FeedbackWorkspaces({ feedback, store, boards });
  const write = (ops: unknown[], by: 'Claude' | 'You' = 'Claude') => feedback.update(root, 'prototype/checkout.html', { version: feedback.read(root, 'prototype/checkout.html').version, ops }, by);
  write([
    { op: 'addRound', label: 'customers' },
    { op: 'addItem', title: 'Hard to find the filters', lines: [{ key: 'Src', text: '1 · Ana · 03:02 · "Where do I filter?"' }, { key: 'Where', text: '#filters' }] },
  ]);
  return { root, feedback, store, boards, workspaces, write };
}

const SHOT = { data: 'data:image/jpeg;base64,AAAA', width: 300, height: 120 };

describe('FeedbackWorkspaces', () => {
  it('makes the item board once, bound to the output, with one frame per round', async () => {
    const { root, store, boards, workspaces, write } = setup();
    expect(await workspaces.open(root, 'prototype/checkout.html', 1, SHOT)).toEqual({ board: 'fb-checkout-1', round: 1, created: true, framed: true });
    expect(store.load('fb-checkout-1').notes).toBe(`Feedback workspace · ${join(realpathSync(root), 'prototype/checkout.html')} #1\n`);
    expect(boards.scenes.get('fb-checkout-1')!.map((e) => e.type)).toEqual(['frame', 'sticky', 'image']);

    expect(await workspaces.open(root, 'prototype/checkout.html', 1, SHOT)).toEqual({ board: 'fb-checkout-1', round: 1, created: false, framed: false });
    expect(boards.draw).toHaveBeenCalledTimes(1);

    // Raised again in round 2: the same board gains a frame to the right.
    write([{ op: 'addRound', label: 'SME' }, { op: 'append', item: 1, key: 'Src', text: '2 · Maya · 00:14 · "No filters"' }]);
    expect(await workspaces.open(root, 'prototype/checkout.html', 1)).toEqual({ board: 'fb-checkout-1', round: 2, created: false, framed: true });
    const frames = boards.scenes.get('fb-checkout-1')!.filter((e) => e.type === 'frame');
    expect(frames.map((f) => f.label)).toEqual(['Round 1', 'Round 2']);
    expect(frames[1]!.x).toBeGreaterThan(frames[0]!.x! + frames[0]!.width!);
  });

  it('ignores a snapshot that is not a picture', async () => {
    const { root, boards, workspaces } = setup();
    await workspaces.open(root, 'prototype/checkout.html', 1, { data: 'javascript:alert(1)', width: 10, height: 10 });
    expect(boards.scenes.get('fb-checkout-1')!.map((e) => e.type)).toEqual(['frame', 'sticky']);
  });

  it('picks the next name when another project holds fb-<stem>-<n>', async () => {
    const { root, store, workspaces } = setup();
    store.create('fb-checkout-1');
    store.saveNotes('fb-checkout-1', 'Feedback workspace · /elsewhere/checkout.html #1\n');
    expect((await workspaces.open(root, 'prototype/checkout.html', 1)).board).toBe('fb-checkout-1-2');
    expect((await workspaces.open(root, 'prototype/checkout.html', 1)).created).toBe(false);
  });

  it('saves the PNG beside the output and logs a Workspace line, sending nothing', async () => {
    const { root, feedback, workspaces } = setup();
    await expect(workspaces.save(root, 'prototype/checkout.html', 1, 'You')).rejects.toThrow(/no workspace yet/);
    await workspaces.open(root, 'prototype/checkout.html', 1);
    const res = await workspaces.save(root, 'prototype/checkout.html', 1, 'You');
    expect(readFileSync(join(root, 'prototype/checkout.html.feedback/1-workspace.png'))).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(readFileSync(join(root, 'prototype/checkout.html.feedback.md'), 'utf8')).toContain('    Workspace: 2026-10-18 · saved · fb-checkout-1 · checkout.html.feedback/1-workspace.png\n');
    expect(res.items[0]!.state).toBe('open');
    expect(feedback.read(root, 'prototype/checkout.html').items[0]!.events.at(-1)).toMatchObject({ key: 'Workspace', verb: 'saved' });
  });

  it('reopens the board a Workspace line names', async () => {
    const { root, store, workspaces, write } = setup();
    store.create('fb-checkout-1-9');
    write([{ op: 'append', item: 1, key: 'Workspace', text: 'saved · fb-checkout-1-9 · checkout.html.feedback/1-workspace.png' }]);
    expect((await workspaces.open(root, 'prototype/checkout.html', 1)).board).toBe('fb-checkout-1-9');
  });

  it('refuses unknown items and bad numbers', async () => {
    const { root, workspaces } = setup();
    await expect(workspaces.open(root, 'prototype/checkout.html', 7)).rejects.toMatchObject({ code: 'not_found' });
    await expect(workspaces.open(root, 'prototype/checkout.html', 0)).rejects.toMatchObject({ code: 'bad_request' });
    await expect(workspaces.open(root, '../checkout.html', 1)).rejects.toThrow(/project/);
  });
});
