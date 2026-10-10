import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { HistoryEntry } from '../shared/ipc';
import { restoredBoardName, SendHistory } from './history';

const temp = () => mkdtempSync(join(tmpdir(), 'history-'));

const entry = (n: number): HistoryEntry => ({
  id: `2026-10-10-1137${String(n).padStart(2, '0')}`,
  sentAt: n,
  board: 'scratch',
  target: 'webAgentCompanion',
  dir: `/p/.feedback/sketches/${n}`,
  draft: `draft ${n}`,
});

describe('SendHistory', () => {
  it('keeps the newest sends up to the limit and deletes older folders', () => {
    const dataDir = temp();
    const history = new SendHistory(dataDir, 3);
    for (let n = 1; n <= 5; n++) history.add(entry(n), { png: Buffer.from(`png ${n}`), scene: { n } });

    expect(history.list().map((e) => e.sentAt)).toEqual([5, 4, 3]);
    expect(readdirSync(history.dir).filter((f) => f !== 'index.json').sort()).toEqual(
      [entry(3).id, entry(4).id, entry(5).id].sort(),
    );
    expect(history.png(entry(5).id)?.toString()).toBe('png 5');
    expect(JSON.parse(history.scene(entry(4).id)!)).toEqual({ n: 4 });
    expect(history.png(entry(1).id)).toBeUndefined();
    expect(existsSync(join(history.dir, entry(1).id))).toBe(false);

    expect(new SendHistory(dataDir, 3).list().map((e) => e.sentAt)).toEqual([5, 4, 3]);
  });

  it('refuses ids that could leave the history folder', () => {
    const history = new SendHistory(temp());
    expect(() => history.add({ ...entry(1), id: '../x' }, { png: Buffer.from(''), scene: {} })).toThrow(/bad history id/);
  });
});

describe('restoredBoardName', () => {
  it('names the board after the send time and avoids taken names', () => {
    const at = new Date(2026, 9, 10, 11, 37).getTime();
    expect(restoredBoardName('scratch', at, () => false)).toBe('scratch 11.37');
    const taken = new Set(['scratch 11.37', 'scratch 11.37 2']);
    expect(restoredBoardName('scratch', at, (n) => taken.has(n))).toBe('scratch 11.37 3');
    expect(restoredBoardName('x'.repeat(64), at, () => false).length).toBeLessThanOrEqual(64);
  });
});
