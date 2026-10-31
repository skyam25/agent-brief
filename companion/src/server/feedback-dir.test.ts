import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { feedbackDir, pruneBundles, pruneScratch, trimPngs } from './feedback-dir';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 17, 12);

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'feedback-dir-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Makes a bundle folder last modified `ageDays` before NOW. */
function bundle(sketches: string, id: string, ageDays: number): void {
  const dir = join(sketches, id);
  mkdirSync(dir, { recursive: true });
  const at = (NOW - ageDays * DAY) / 1000;
  utimesSync(dir, at, at);
}

describe('feedbackDir', () => {
  it('makes the folder with a .gitignore of *', () => {
    const dir = feedbackDir(root);
    expect(dir).toBe(join(root, '.feedback'));
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('*\n');
  });

  it('leaves an existing .gitignore alone', () => {
    mkdirSync(join(root, '.feedback'));
    writeFileSync(join(root, '.feedback', '.gitignore'), 'items/\n');
    feedbackDir(root);
    expect(readFileSync(join(root, '.feedback', '.gitignore'), 'utf8')).toBe('items/\n');
  });
});

describe('pruneBundles', () => {
  it('deletes old bundles past the newest ones it keeps', () => {
    const sketches = join(root, 'sketches');
    bundle(sketches, '2026-09-01-100000', 46);
    bundle(sketches, '2026-09-02-100000-ab12', 45);
    bundle(sketches, '2026-10-16-100000', 1);
    pruneBundles(sketches, NOW, 1);
    expect(readdirSync(sketches)).toEqual(['2026-10-16-100000']);
  });

  it('keeps the newest bundles whatever their age', () => {
    const sketches = join(root, 'sketches');
    bundle(sketches, '2026-09-01-100000', 46);
    bundle(sketches, '2026-09-02-100000', 45);
    pruneBundles(sketches, NOW, 2);
    expect(readdirSync(sketches).sort()).toEqual(['2026-09-01-100000', '2026-09-02-100000']);
  });

  it('keeps recent bundles past the count', () => {
    const sketches = join(root, 'sketches');
    bundle(sketches, '2026-10-10-100000', 7);
    bundle(sketches, '2026-10-16-100000', 1);
    pruneBundles(sketches, NOW, 1);
    expect(readdirSync(sketches)).toHaveLength(2);
  });

  it('never touches folders not named like bundles', () => {
    const sketches = join(root, 'sketches');
    bundle(sketches, 'keep-me', 90);
    pruneBundles(sketches, NOW, 0);
    expect(existsSync(join(sketches, 'keep-me'))).toBe(true);
  });

  it('does nothing when the folder is missing', () => {
    expect(() => pruneBundles(join(root, 'none'), NOW)).not.toThrow();
  });
});

describe('trimPngs', () => {
  it('keeps the newest PNGs and other files', () => {
    for (const [name, ageDays] of [['a.png', 3], ['b.png', 2], ['c.png', 1], ['notes.txt', 9]] as const) {
      writeFileSync(join(root, name), '');
      const at = (NOW - ageDays * DAY) / 1000;
      utimesSync(join(root, name), at, at);
    }
    trimPngs(root, 2);
    expect(readdirSync(root).sort()).toEqual(['b.png', 'c.png', 'notes.txt']);
  });
});

describe('pruneScratch', () => {
  it('deletes scratch files older than a week and keeps newer ones', () => {
    const scratch = join(root, '.feedback', 'scratch');
    mkdirSync(scratch, { recursive: true });
    for (const [name, ageDays] of [['old.json', 8], ['new.json', 2]] as const) {
      writeFileSync(join(scratch, name), '{}');
      const at = (NOW - ageDays * DAY) / 1000;
      utimesSync(join(scratch, name), at, at);
    }
    pruneScratch(join(root, '.feedback'), NOW);
    expect(readdirSync(scratch)).toEqual(['new.json']);
    expect(() => pruneScratch(join(root, 'none'), NOW)).not.toThrow();
  });
});
