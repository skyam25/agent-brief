import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ItemsWatcher } from './items-watch';

const watchers: ItemsWatcher[] = [];
afterEach(() => {
  while (watchers.length) watchers.pop()!.close();
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'items-'));
  const dir = join(root, '.feedback', 'items');
  const file = join(dir, 's1.md');
  const seen: string[] = [];
  const w = new ItemsWatcher((id) => seen.push(id), { debounceMs: 30, pollMs: 40 });
  watchers.push(w);
  return { root, dir, file, seen, w };
}

const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));

describe('ItemsWatcher', () => {
  it('polls until the folder exists, then reports the new file once', async () => {
    const t = setup();
    t.w.sync(new Map([['s1', t.file]]));
    await settle(100);
    expect(t.seen).toEqual([]);
    mkdirSync(t.dir, { recursive: true });
    writeFileSync(t.file, '- [ ] #1 A\n');
    await vi.waitFor(() => expect(t.seen).toEqual(['s1']), { timeout: 2000 });
    await settle();
    expect(t.seen).toEqual(['s1']);
  });

  it('reports changes in a watched folder, one per burst', async () => {
    const t = setup();
    mkdirSync(t.dir, { recursive: true });
    writeFileSync(t.file, 'a');
    t.w.sync(new Map([['s1', t.file]]));
    await settle(50);
    for (const text of ['b', 'cc', 'ddd']) writeFileSync(t.file, text);
    await vi.waitFor(() => expect(t.seen.length).toBeGreaterThan(0), { timeout: 2000 });
    await settle();
    expect(t.seen).toEqual(['s1']);

    writeFileSync(join(t.dir, 'other.md'), 'x');
    await settle();
    expect(t.seen).toEqual(['s1']);
  });

  it('goes back to polling when the folder is removed, and picks the file up again', async () => {
    const t = setup();
    mkdirSync(t.dir, { recursive: true });
    t.w.sync(new Map([['s1', t.file]]));
    rmSync(join(t.root, '.feedback'), { recursive: true });
    await settle();
    t.seen.length = 0;
    mkdirSync(t.dir, { recursive: true });
    writeFileSync(t.file, 'back');
    await vi.waitFor(() => expect(t.seen).toContain('s1'), { timeout: 2000 });
  });

  it('stops reporting after sync drops a session, and after close', async () => {
    const t = setup();
    mkdirSync(t.dir, { recursive: true });
    const other = join(t.dir, 's2.md');
    t.w.sync(new Map([['s1', t.file], ['s2', other]]));
    expect([...t.w.watched().keys()]).toEqual(['s1', 's2']);

    t.w.sync(new Map([['s2', other]]));
    expect([...t.w.watched().keys()]).toEqual(['s2']);
    writeFileSync(t.file, 'x');
    await settle();
    expect(t.seen).toEqual([]);

    writeFileSync(other, 'y');
    await vi.waitFor(() => expect(t.seen).toEqual(['s2']), { timeout: 2000 });

    t.w.close();
    expect(t.w.watched().size).toBe(0);
    writeFileSync(other, 'z');
    await settle();
    expect(t.seen).toEqual(['s2']);
  });

  it('restarts a session whose path moved', async () => {
    const t = setup();
    const moved = join(t.root, 'elsewhere', 's1.md');
    t.w.sync(new Map([['s1', t.file]]));
    t.w.sync(new Map([['s1', moved]]));
    expect(t.w.watched().get('s1')).toBe(moved);
    mkdirSync(join(t.root, 'elsewhere'));
    writeFileSync(moved, 'x');
    await vi.waitFor(() => expect(t.seen).toEqual(['s1']), { timeout: 2000 });
  });
});
