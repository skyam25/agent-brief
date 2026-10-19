import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { DrawRequest, ReadResponse, Skeleton } from '../protocol';
import { tempDir } from '../server/testkit';
import { DraftStore } from './drafts';
import { FeedbackStore } from './feedback';
import { FeedbackWorkspaces } from './feedback-workspace';
import { BoardStore } from './store';

/** Board work as the renderer does it, kept as the skeletons each board was given, with real ids. */
function fakeBoards() {
  const scenes = new Map<string, (Skeleton & { id: string })[]>();
  let seq = 0;
  const read = vi.fn(async (board: string): Promise<ReadResponse> => {
    const els = scenes.get(board) ?? [];
    const right = Math.max(0, ...els.map((e) => (e.x ?? 0) + (e.width ?? 0)));
    const bottom = Math.max(0, ...els.map((e) => (e.y ?? 0) + (e.height ?? 0)));
    return { board, elements: els.map((e) => ({ by: 'claude', x: 0, y: 0, width: 0, height: 0, ...e, type: e.type })) as ReadResponse['elements'], bounds: { x: 0, y: 0, width: right, height: bottom } };
  });
  const draw = vi.fn(async (board: string, req: DrawRequest) => {
    const ids = new Map(req.elements.map((e) => [e.id ?? '', `e${++seq}`]));
    const placed = req.elements.map((e) => ({ ...e, id: ids.get(e.id ?? '')!, ...(e.frameId ? { frameId: ids.get(e.frameId) ?? e.frameId } : {}) }));
    scenes.set(board, [...(scenes.get(board) ?? []), ...placed]);
    return { ids: placed.map((e) => e.id), batchId: 'b' };
  });
  const png = vi.fn(async () => Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return { scenes, read, draw, png };
}

function setup(shared?: { store: BoardStore; boards: ReturnType<typeof fakeBoards> }) {
  const root = tempDir();
  mkdirSync(join(root, 'prototype'));
  writeFileSync(join(root, 'prototype/checkout.html'), '<div id="filters"></div>');
  const feedback = new FeedbackStore(undefined, () => new Date(2026, 9, 18));
  const store = shared?.store ?? new BoardStore(tempDir());
  const boards = shared?.boards ?? fakeBoards();
  const workspaces = new FeedbackWorkspaces({ feedback, store, boards });
  const write = (ops: unknown[], by: 'Claude' | 'You' = 'Claude') => feedback.update(root, 'prototype/checkout.html', { version: feedback.read(root, 'prototype/checkout.html').version, ops }, by);
  write([
    { op: 'addRound', label: 'customers' },
    { op: 'addItem', title: 'Hard to find the filters', lines: [{ key: 'Src', text: '1 · Ana · 03:02 · "Where do I filter?"' }, { key: 'Where', text: '#filters' }] },
  ]);
  return { root, feedback, store, boards, workspaces, write };
}

const types = (els: Skeleton[] | undefined) => (els ?? []).map((e) => e.type);

const SHOT = { data: 'data:image/jpeg;base64,AAAA', width: 300, height: 120 };

describe('FeedbackWorkspaces', () => {
  it('makes the item board once, bound to the output, with one frame per round', async () => {
    const { root, store, boards, workspaces, write } = setup();
    expect(await workspaces.open(root, 'prototype/checkout.html', 1, SHOT)).toEqual({ board: 'fb-checkout-1', round: 1, created: true, framed: true });
    expect(store.load('fb-checkout-1').notes).toBe(`Feedback workspace · ${join(realpathSync(root), 'prototype/checkout.html')} #1\n`);
    expect(types(boards.scenes.get('fb-checkout-1'))).toEqual(['frame', 'sticky', 'image']);

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
    expect(types(boards.scenes.get('fb-checkout-1'))).toEqual(['frame', 'sticky']);
  });

  it('picks the next name when another project holds fb-<stem>-<n>', async () => {
    const { root, store, workspaces } = setup();
    store.create('fb-checkout-1');
    store.saveNotes('fb-checkout-1', 'Feedback workspace · /elsewhere/checkout.html #1\n');
    expect((await workspaces.open(root, 'prototype/checkout.html', 1)).board).toBe('fb-checkout-1-2');
    expect((await workspaces.open(root, 'prototype/checkout.html', 1)).created).toBe(false);
  });

  it('saves each PNG as a new revision beside the output and logs a Workspace line, sending nothing', async () => {
    const { root, feedback, workspaces } = setup();
    await expect(workspaces.save(root, 'prototype/checkout.html', 1, 'You')).rejects.toThrow(/no workspace yet/);
    await workspaces.open(root, 'prototype/checkout.html', 1);
    const res = await workspaces.save(root, 'prototype/checkout.html', 1, 'You');
    expect(readFileSync(join(root, 'prototype/checkout.html.feedback/1-workspace-1.png'))).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(res.items[0]!.state).toBe('open');
    await workspaces.save(root, 'prototype/checkout.html', 1, 'You');
    const text = readFileSync(join(root, 'prototype/checkout.html.feedback.md'), 'utf8');
    expect(text).toContain('    Workspace: 2026-10-18 · saved · fb-checkout-1 · checkout.html.feedback/1-workspace-1.png\n');
    expect(text).toContain('    Workspace: 2026-10-18 · saved · fb-checkout-1 · checkout.html.feedback/1-workspace-2.png\n');
    expect(readdirSync(join(root, 'prototype/checkout.html.feedback')).sort()).toEqual(['1-workspace-1.png', '1-workspace-2.png']);
    expect(feedback.read(root, 'prototype/checkout.html').items[0]!.events.at(-1)).toMatchObject({ key: 'Workspace', verb: 'saved' });
  });

  it('skips a revision name a file already holds', async () => {
    const { root, workspaces } = setup();
    await workspaces.open(root, 'prototype/checkout.html', 1);
    mkdirSync(join(root, 'prototype/checkout.html.feedback'));
    writeFileSync(join(root, 'prototype/checkout.html.feedback/1-workspace-1.png'), 'mine');
    await workspaces.save(root, 'prototype/checkout.html', 1, 'You');
    expect(readFileSync(join(root, 'prototype/checkout.html.feedback/1-workspace-1.png'), 'utf8')).toBe('mine');
    expect(existsSync(join(root, 'prototype/checkout.html.feedback/1-workspace-2.png'))).toBe(true);
  });

  it('refuses a save whose folder became a link outside the project while the PNG exported', async () => {
    const { root, boards, workspaces } = setup();
    await workspaces.open(root, 'prototype/checkout.html', 1);
    const outside = tempDir();
    boards.png.mockImplementationOnce(async () => {
      // The output's folder moves out and a link to a folder elsewhere takes its place.
      cpSync(join(root, 'prototype'), join(outside, 'prototype'), { recursive: true });
      rmSync(join(root, 'prototype'), { recursive: true });
      symlinkSync(join(outside, 'prototype'), join(root, 'prototype'));
      return Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    });
    await expect(workspaces.save(root, 'prototype/checkout.html', 1, 'You')).rejects.toThrow(/project/);
    expect(existsSync(join(outside, 'prototype/checkout.html.feedback'))).toBe(false);
  });

  it('refuses a save whose assets folder became a link while the PNG exported', async () => {
    const { root, boards, workspaces } = setup();
    await workspaces.open(root, 'prototype/checkout.html', 1);
    const outside = tempDir();
    boards.png.mockImplementationOnce(async () => {
      symlinkSync(outside, join(root, 'prototype/checkout.html.feedback'));
      return Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    });
    await expect(workspaces.save(root, 'prototype/checkout.html', 1, 'You')).rejects.toThrow(/folder/);
    expect(readdirSync(outside)).toEqual([]);
  });

  it('reopens the board a Workspace line names when its binding matches', async () => {
    const { root, store, workspaces, write } = setup();
    store.create('fb-checkout-1-9');
    store.saveNotes('fb-checkout-1-9', `Feedback workspace · ${join(realpathSync(root), 'prototype/checkout.html')} #1\n`);
    write([{ op: 'append', item: 1, key: 'Workspace', text: 'saved · fb-checkout-1-9 · checkout.html.feedback/1-workspace-1.png' }]);
    expect((await workspaces.open(root, 'prototype/checkout.html', 1)).board).toBe('fb-checkout-1-9');
  });

  it('never adopts a board a Workspace line names when it is bound elsewhere or not at all', async () => {
    const { root, store, workspaces, write } = setup();
    const other = setup({ store, boards: fakeBoards() });
    await other.workspaces.open(other.root, 'prototype/checkout.html', 1);
    const foreignNotes = store.load('fb-checkout-1').notes;
    store.create('planning');
    write([{ op: 'append', item: 1, key: 'Workspace', text: 'saved · fb-checkout-1 · checkout.html.feedback/1-workspace-1.png' }]);
    expect(await workspaces.open(root, 'prototype/checkout.html', 1)).toMatchObject({ board: 'fb-checkout-1-2', created: true });
    expect(store.load('fb-checkout-1').notes).toBe(foreignNotes);
    write([{ op: 'append', item: 1, key: 'Workspace', text: 'saved · planning · checkout.html.feedback/1-workspace-2.png' }]);
    expect((await workspaces.open(root, 'prototype/checkout.html', 1)).board).toBe('fb-checkout-1-2');
    expect(store.load('planning').notes).toBe('');
  });

  it('gives a copied project its own board and leaves the original alone', async () => {
    const a = setup();
    await a.workspaces.open(a.root, 'prototype/checkout.html', 1);
    await a.workspaces.save(a.root, 'prototype/checkout.html', 1, 'You');
    const copy = tempDir();
    cpSync(a.root, copy, { recursive: true });
    const b = new FeedbackWorkspaces({ feedback: a.feedback, store: a.store, boards: a.boards });
    const opened = await b.open(copy, 'prototype/checkout.html', 1);
    expect(opened).toMatchObject({ board: 'fb-checkout-1-2', created: true });
    expect(a.store.load('fb-checkout-1').notes).toContain(join(realpathSync(a.root), 'prototype/checkout.html'));
    expect((await b.save(copy, 'prototype/checkout.html', 1, 'You')).items[0]!.events.at(-1)!.detail).toContain('fb-checkout-1-2');
  });

  it('rebinds the board when the project moved and its old output is gone', async () => {
    const a = setup();
    await a.workspaces.open(a.root, 'prototype/checkout.html', 1);
    await a.workspaces.save(a.root, 'prototype/checkout.html', 1, 'You');
    const moved = `${a.root}-moved`;
    renameSync(a.root, moved);
    expect(await a.workspaces.open(moved, 'prototype/checkout.html', 1)).toMatchObject({ board: 'fb-checkout-1', created: false });
    expect(a.store.load('fb-checkout-1').notes).toBe(`Feedback workspace · ${join(realpathSync(moved), 'prototype/checkout.html')} #1\n`);
  });

  it('frames each round once when opens overlap', async () => {
    const { root, boards, workspaces, write } = setup();
    write([{ op: 'addRound', label: 'SME' }, { op: 'append', item: 1, key: 'Src', text: '2 · Maya · 00:14 · "No filters"' }]);
    const reads = boards.read.getMockImplementation()!;
    // Each read answers late, after the other opens have read the same scene.
    boards.read.mockImplementation(async (board) => {
      const scene = await reads(board);
      await new Promise((r) => setTimeout(r, 5));
      return scene;
    });
    await Promise.all([workspaces.open(root, 'prototype/checkout.html', 1, SHOT), workspaces.open(root, 'prototype/checkout.html', 1), workspaces.open(root, 'prototype/checkout.html', 1, SHOT)]);
    const scene = boards.scenes.get('fb-checkout-1')!;
    expect(scene.filter((e) => e.type === 'frame').map((e) => e.label)).toEqual(['Round 1', 'Round 2']);
    expect(scene.filter((e) => e.type === 'sticky')).toHaveLength(2);
    expect(scene.filter((e) => e.type === 'image')).toHaveLength(1);
  });

  it('adds the snapshot to a frame the CLI made without one, and frames every round on first open', async () => {
    const { root, boards, workspaces, write } = setup();
    await workspaces.open(root, 'prototype/checkout.html', 1);
    expect(types(boards.scenes.get('fb-checkout-1'))).toEqual(['frame', 'sticky']);
    expect(await workspaces.open(root, 'prototype/checkout.html', 1, SHOT)).toMatchObject({ framed: true });
    const scene = boards.scenes.get('fb-checkout-1')!;
    expect(scene.find((e) => e.type === 'image')!.frameId).toBe(scene[0]!.id);
    expect(await workspaces.open(root, 'prototype/checkout.html', 1, SHOT)).toMatchObject({ framed: false });

    write([{ op: 'addRound', label: 'SME' }, { op: 'addItem', title: 'Prices hidden', lines: [{ key: 'Src', text: '1 · Ana · 04:00 · "Where is the price?"' }, { key: 'Src', text: '2 · Maya · 01:00 · "No price"' }] }]);
    await workspaces.open(root, 'prototype/checkout.html', 2);
    expect(boards.scenes.get('fb-checkout-2')!.filter((e) => e.type === 'frame').map((e) => e.label)).toEqual(['Round 1', 'Round 2']);
  });

  it('keeps the comments as You notes before the Workspace line, with badges for the pins that have words', async () => {
    const { root, boards, workspaces } = setup();
    await workspaces.open(root, 'prototype/checkout.html', 1);
    const pin = (id: string, text: string, label?: string) => ({ id, x: 10, y: 20, type: 'sticky', ...(label ? { label } : {}), text, createdAt: 1 });
    const comments = { overall: 'Option B reads better\nmostly', pins: [pin('bp-1', '', 'empty'), pin('bp-2', 'make it\nbigger', 'Option B: sticky filters')] };
    const res = await workspaces.save(root, 'prototype/checkout.html', 1, 'You', comments);
    expect(boards.png).toHaveBeenLastCalledWith('fb-checkout-1', { maxEdge: 2400, pins: [expect.objectContaining({ id: 'bp-2' })] });
    expect(res.items[0]!.lines.slice(-3).map((l) => `${l.key}: ${l.text}`)).toEqual([
      'You: 2026-10-18 · note · pin 1 on sticky “Option B: sticky filters” · make it bigger',
      'You: 2026-10-18 · note · Option B reads better mostly',
      'Workspace: 2026-10-18 · saved · fb-checkout-1 · checkout.html.feedback/1-workspace-1.png',
    ]);
    // Claude's saves never carry the user's words.
    const again = await workspaces.save(root, 'prototype/checkout.html', 1, 'Claude', comments);
    expect(again.items[0]!.lines.at(-2)!.key).toBe('Workspace');
  });

  it('makes the item\'s Write note once, logs it, and opens it after', () => {
    const { root, feedback, store, boards } = setup();
    const drafts = new DraftStore(tempDir());
    const show = vi.fn();
    const workspaces = new FeedbackWorkspaces({ feedback, store, boards, notes: { drafts, show } });
    const made = workspaces.note(root, 'prototype/checkout.html', 1, 's1');
    expect(made.created).toBe(true);
    const draft = drafts.get(made.draftId)!;
    expect(draft).toMatchObject({ sessionId: 's1', title: '#1 Hard to find the filters' });
    expect(draft.body).toContain('Feedback item #1 on prototype/checkout.html.');
    expect(draft.body).toContain('> “Where do I filter?” — Ana');
    expect(show).toHaveBeenLastCalledWith('s1', made.draftId);
    expect(feedback.read(root, 'prototype/checkout.html').items[0]!.events.at(-1)).toMatchObject({ key: 'You', verb: 'note', detail: 'Write note "#1 Hard to find the filters"' });

    expect(workspaces.note(root, 'prototype/checkout.html', 1, 's1')).toEqual({ draftId: made.draftId, created: false });
    expect(feedback.read(root, 'prototype/checkout.html').items[0]!.events.filter((e) => e.detail.startsWith('Write note'))).toHaveLength(1);
    expect(workspaces.note(root, 'prototype/checkout.html', 1, 's2').created).toBe(true);
  });

  it('refuses unknown items and bad numbers', async () => {
    const { root, workspaces } = setup();
    await expect(workspaces.open(root, 'prototype/checkout.html', 7)).rejects.toMatchObject({ code: 'not_found' });
    await expect(workspaces.open(root, 'prototype/checkout.html', 0)).rejects.toMatchObject({ code: 'bad_request' });
    await expect(workspaces.open(root, '../checkout.html', 1)).rejects.toThrow(/project/);
  });
});
