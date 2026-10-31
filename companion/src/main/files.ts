/** File helpers the main-process stores share. */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { BoardError, badRequest } from '../board/errors';

export const hash = (text: string) => createHash('sha256').update(text).digest('hex');

/** The version a reader sees: the text's hash, or `missing` for no file. */
export const fileVersion = (text: string | undefined) => (text === undefined ? 'missing' : hash(text));

/** A file's text, or undefined when it is absent. `path` names it in the error for a file over `maxBytes`. */
export function readCapped(file: string, path: string, maxBytes: number): string | undefined {
  if (!existsSync(file)) return undefined;
  if (statSync(file).size > maxBytes) throw badRequest(`${path} exceeds ${maxBytes / 1024 / 1024} MB`);
  return readFileSync(file, 'utf8');
}

/** Refuses a write made at `expected` once the file moved past it. No `expected` writes at any version. */
export function checkVersion(text: string | undefined, expected: string | undefined, what: string): void {
  if (expected !== undefined && fileVersion(text) !== expected) throw new BoardError('conflict', `${what} changed since you read it. Read it again and retry. Nothing was written.`);
}

/** Writes through a hidden temp file and a rename, so readers never see half a file. */
export function writeAtomic(path: string, text: string): void {
  const tmp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    writeFileSync(tmp, text, { flag: 'wx' });
    renameSync(tmp, path);
  } finally {
    if (existsSync(tmp)) unlinkSync(tmp);
  }
}

/** The project scan stops at these. */
const MAX_FILES = 200;
const MAX_DIRS = 5000;

/**
 * Files under the project whose names match, in a stable order, skipping dot folders,
 * node_modules and files over `maxBytes`.
 */
export function scanProject(realRoot: string, match: (name: string) => boolean, maxBytes: number): { found: string[]; truncated: boolean } {
  const found: string[] = [];
  const queue = [realRoot];
  let dirs = 0;
  while (queue.length) {
    if (++dirs > MAX_DIRS) return { found, truncated: true };
    const dir = queue.shift()!;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) queue.push(full);
      else if (e.isFile() && match(e.name)) {
        if (found.length >= MAX_FILES) return { found, truncated: true };
        if (statSync(full).size <= maxBytes) found.push(full);
      }
    }
  }
  return { found, truncated: false };
}
