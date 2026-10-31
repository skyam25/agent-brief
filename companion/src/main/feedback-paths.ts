/**
 * Resolves feedback outputs, files and asset folders inside a project. Every check
 * runs on the canonical path as well as the one supplied, so a symlink cannot alias
 * a dot folder, a feedback file or a folder outside the project.
 */

import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { FEEDBACK_SUFFIX, feedbackAssets, feedbackPath } from '../shared/feedback';
import { badRequest } from '../board/errors';

const bad = (s: string): never => { throw badRequest(s); };

const CONTROL = /[\u0000-\u001f\u007f]/;

export const within = (root: string, p: string) => { const rel = relative(root, p); return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };

/** A relative path whose segments are not empty, start with no dot and hold no control characters. */
export const plainRelative = (rel: string) => !isAbsolute(rel) && !CONTROL.test(rel) && rel.split(/[\\/]/).every((p) => p && !p.startsWith('.'));

export interface FeedbackTarget {
  realRoot: string;
  /** The output, canonical and project-relative. */
  output: string;
  /** The output's canonical absolute path. */
  outputFile: string;
  /** False for a feedback file whose output is gone. */
  outputExists: boolean;
  /** The feedback file, absolute and project-relative. */
  file: string;
  path: string;
}

function targetOf(realRoot: string, real: string, outputExists: boolean): FeedbackTarget {
  const output = relative(realRoot, real);
  if (!within(realRoot, real) || !plainRelative(output)) return bad('Output must be a file inside the project, outside dot folders');
  if (output.endsWith(FEEDBACK_SUFFIX)) return bad('Name the output, not its feedback file');
  const file = feedbackPath(real);
  if (existsSync(file) && (lstatSync(file).isSymbolicLink() || !statSync(file).isFile())) return bad('Feedback file must be a regular file');
  return { realRoot, output, outputFile: real, outputExists, file, path: relative(realRoot, file) };
}

/**
 * The output and its feedback file. The output must be a file inside the project.
 * With `orphan`, a feedback file whose output is gone resolves too, for reading only.
 */
export function resolveFeedback(root: string, output: unknown, opts: { orphan?: boolean } = {}): FeedbackTarget {
  if (typeof output !== 'string' || !plainRelative(output)) return bad('Expected a project-relative output path without dot folders or control characters');
  if (output.endsWith(FEEDBACK_SUFFIX)) return bad('Name the output, not its feedback file');
  const realRoot = realpathSync(root);
  const target = resolve(realRoot, output);
  if (!within(realRoot, target)) return bad('Output must be a file inside the project');
  if (existsSync(target)) {
    const real = realpathSync(target);
    if (!within(realRoot, real) || !statSync(real).isFile()) return bad('Output must be a file inside the project');
    return targetOf(realRoot, real, true);
  }
  if (!opts.orphan || !existsSync(dirname(target))) return bad('Output must be a file inside the project');
  const found = targetOf(realRoot, join(realpathSync(dirname(target)), basename(target)), false);
  return existsSync(found.file) ? found : bad('Output must be a file inside the project');
}

const lstatOrUndefined = (p: string) => { try { return lstatSync(p); } catch { return undefined; } };

export interface FeedbackAssetsDir {
  target: FeedbackTarget;
  /** The sibling folder, absolute and project-relative. */
  dir: string;
  rel: string;
}

/**
 * The output's sibling folder, made when missing. It resolves the output again,
 * so call it after any await and right before writing. `expect` is the canonical
 * output the caller read before; a different one means a parent was swapped.
 */
export function feedbackAssetsDir(root: string, output: string, expect: string = output): FeedbackAssetsDir {
  const target = resolveFeedback(root, output);
  if (target.output !== expect) return bad(`${expect} moved while it was being read. Nothing was written.`);
  const dir = feedbackAssets(target.outputFile);
  const rel = relative(target.realRoot, dir);
  if (!plainRelative(rel)) return bad(`${rel} is not a plain project folder`);
  const there = lstatOrUndefined(dir);
  if (there && (there.isSymbolicLink() || !there.isDirectory())) return bad(`${rel} must be a folder`);
  if (!there) mkdirSync(dir);
  if (realpathSync(dir) !== dir) return bad(`${rel} must be a folder inside the project`);
  return { target, dir, rel };
}

/**
 * Writes a new file in a folder from feedbackAssetsDir. Assets are immutable, so
 * it answers false when `name` is taken and never replaces a file or follows a link.
 */
export function writeFeedbackAsset(assets: FeedbackAssetsDir, name: string, bytes: Uint8Array): boolean {
  if (!plainRelative(name) || /[\\/]/.test(name)) return bad(`${name} is not a plain file name`);
  if (realpathSync(assets.dir) !== assets.dir) return bad(`${assets.rel} must be a folder inside the project`);
  const file = join(assets.dir, name);
  try {
    writeFileSync(file, bytes, { flag: 'wx' });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    rmSync(file, { force: true });
    throw err;
  }
}
