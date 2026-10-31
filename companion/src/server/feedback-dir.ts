/** The `.feedback` folder Agent Brief keeps in a project, and its upkeep. */

import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Sketch bundles stay this long. */
export const BUNDLE_MAX_AGE_MS = 14 * DAY_MS;

/** The newest bundles stay whatever their age. */
export const BUNDLE_KEEP = 20;

/** The board PNGs `agent-brief png` keeps by default. */
export const BOARD_PNG_KEEP = 20;

/** Files the skills write for one command, such as a catalog's points, stay this long. */
export const SCRATCH_MAX_AGE_MS = 7 * DAY_MS;

/** A bundle folder's name, as `freeId` makes it. */
const BUNDLE_ID = /^\d{4}-\d{2}-\d{2}-\d{6}(?:-[0-9a-f]{4})?$/;

/**
 * Makes `<cwd>/.feedback` and returns it. A `.gitignore` of `*` inside keeps the
 * folder out of git without touching the project's own `.gitignore`.
 */
export function feedbackDir(cwd: string): string {
  const dir = join(cwd, '.feedback');
  mkdirSync(dir, { recursive: true });
  const ignore = join(dir, '.gitignore');
  if (!existsSync(ignore)) writeFileSync(ignore, '*\n');
  return dir;
}

/**
 * Deletes sketch bundles older than `maxAgeMs`, always keeping the newest `keep`.
 * Touches only folders named like bundles. Best effort.
 */
export function pruneBundles(sketchesDir: string, now: number, keep = BUNDLE_KEEP, maxAgeMs = BUNDLE_MAX_AGE_MS): void {
  try {
    const ids = readdirSync(sketchesDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && BUNDLE_ID.test(d.name))
      .map((d) => d.name)
      .sort()
      .reverse();
    for (const id of ids.slice(keep)) {
      const dir = join(sketchesDir, id);
      if (now - statSync(dir).mtimeMs > maxAgeMs) rmSync(dir, { recursive: true, force: true });
    }
  } catch {
    // A failed prune leaves old bundles for the next one.
  }
}

/** Deletes files in `.feedback/scratch` older than `maxAgeMs`. Best effort. */
export function pruneScratch(feedback: string, now: number, maxAgeMs = SCRATCH_MAX_AGE_MS): void {
  try {
    const dir = join(feedback, 'scratch');
    for (const name of readdirSync(dir)) {
      const file = join(dir, name);
      if (now - statSync(file).mtimeMs > maxAgeMs) rmSync(file, { recursive: true, force: true });
    }
  } catch {
    // A failed prune leaves the files for the next one.
  }
}

/** The upkeep each Send runs: old sketch bundles and old scratch files go. */
export function tidyFeedback(feedback: string, now: number): void {
  pruneBundles(join(feedback, 'sketches'), now);
  pruneScratch(feedback, now);
}

/** Keeps the newest `keep` PNGs in `dir` by modified time. Best effort. */
export function trimPngs(dir: string, keep: number): void {
  try {
    const pngs = readdirSync(dir)
      .filter((name) => name.endsWith('.png'))
      .map((name) => ({ path: join(dir, name), at: statSync(join(dir, name)).mtimeMs }))
      .sort((a, b) => b.at - a.at);
    for (const old of pngs.slice(keep)) rmSync(old.path, { force: true });
  } catch {
    // A failed trim leaves the files for the next one.
  }
}
