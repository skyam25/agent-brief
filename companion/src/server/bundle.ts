/** Writes a delivery bundle under a session's project and builds its draft. */

import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import { boardCommentsAsk, boardCommentsMarkdown } from '../shared/board-comments';
import { imageRefs } from '../shared/drafts';
import { annotationsAsk, annotationsMarkdown } from '../shared/annotations';
import { reviewAsk, reviewMarkdown } from '../shared/review';
import type { DeliveryInput } from './contract';

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** Local time as `yyyy-mm-dd-hhmmss`. */
export function timestampId(ms: number): string {
  const d = new Date(ms);
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return `${date}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/** Picks an id whose folder does not exist yet, adding a random suffix on a collision. */
export function freeId(sketchesDir: string, ms: number): string {
  const base = timestampId(ms);
  let id = base;
  while (existsSync(join(sketchesDir, id))) id = `${base}-${randomBytes(2).toString('hex')}`;
  return id;
}

/** Opens a list item, task or quote, which an image line keeps. */
const LINE_MARKERS = /^\s*(?:(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?|>\s*)*$/;

/**
 * Points each `![alt](att:<id>)` at its file in the bundle, as an `@` line Claude Code
 * attaches. The alt text follows the path. A picture inside a paragraph gets a line
 * of its own, and one in a table row stays in its cell. A reference with no file
 * keeps only its alt text.
 */
export function rewriteImages(text: string, bundleId: string, images: readonly { name: string }[]): string {
  const files = new Map(images.map((img) => [basename(img.name).replace(/\.[^.]*$/, ''), basename(img.name)]));
  const at = (id: string, alt: string) => {
    const name = files.get(id);
    if (!name) return alt;
    return `@.feedback/sketches/${bundleId}/images/${name}${alt.trim() ? ` — ${alt.trim()}` : ''}`;
  };
  return text
    .split('\n')
    .flatMap((line) => {
      const refs = imageRefs(line);
      if (!refs.length) return [line];
      if (line.trimStart().startsWith('|')) {
        let out = line;
        for (const r of refs) out = out.replace(r.match, () => at(r.id, r.alt).replace(/\|/g, '\\|'));
        return [out];
      }
      const out: string[] = [];
      let rest = 0;
      refs.forEach((r, i) => {
        const before = line.slice(rest, r.index);
        const marker = i === 0 && LINE_MARKERS.test(before);
        if (!marker && before.trim()) out.push(i === 0 ? before.trimEnd() : before.trim());
        const ref = at(r.id, r.alt);
        if (ref) out.push(marker ? `${before}${ref}` : ref);
        rest = r.index + r.match.length;
      });
      const after = line.slice(rest).trim();
      if (after) out.push(after);
      return out;
    })
    .join('\n');
}

/**
 * A draft's source file as the prompt may name it: a project-relative path on one line,
 * with no `..` segment. Undefined for anything else.
 */
export function cleanSourcePath(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const path = raw.trim();
  if (!path || path.length > 1024 || /[\u0000-\u001f\u007f]/.test(path) || isAbsolute(path)) return undefined;
  if (path.split(/[\\/]/).includes('..')) return undefined;
  return path;
}

/**
 * The prompt Claude Code receives. A written draft goes first, word for word, then the sketch lines.
 * A draft opened from a project file is not repeated. Its lines point at draft.md and ask Claude to apply it to the file.
 * A review's lines point at review.md instead. A draft with comments on its passages points at draft.md and annotations.md.
 */
export function buildDraft(id: string, input: DeliveryInput): string {
  const rel = `.feedback/sketches/${id}`;
  const source = cleanSourcePath(input.sourcePath);
  const sourceLines = input.review
    ? [`@${rel}/review.md`, reviewAsk(input.review)]
    : input.annotations
      ? [`@${rel}/draft.md`, `@${rel}/annotations.md`, annotationsAsk(input.annotations, source)]
      : source
      ? [`@${rel}/draft.md`, `My edited copy of ${source} from Agent Brief. Apply the changes to ${source}, keep what I did not touch, then say what changed.`]
      : undefined;
  const text = sourceLines ? sourceLines.join('\n') : input.text && rewriteImages(input.text, id, input.images ?? []).trim();
  if (!input.png) return text ?? '';
  const lines = [`@${rel}/sketch.png`, `Sketch from the Agent Brief board "${input.boardName}".`];
  if (input.comments) lines.unshift(`@${rel}/comments.md`, boardCommentsAsk(input.boardName, input.comments), '');
  if (text) lines.unshift(text, '');
  if (input.speech) lines.push(`Said while drawing: "${input.speech}"`);
  if (input.notes) {
    const oneLine = input.notes.replace(/\s+/g, ' ').trim().slice(0, 300);
    lines.push(`Notes: ${oneLine}`);
  }
  if (input.timelineMd) lines.push(`Timeline: ${rel}/timeline.md`);
  return lines.join('\n');
}

export async function writeBundle(dir: string, input: DeliveryInput): Promise<void> {
  await mkdir(dir, { recursive: true });
  const writes: Promise<void>[] = [];
  if (input.png) {
    writes.push(
      writeFile(join(dir, 'sketch.png'), input.png),
      writeFile(join(dir, 'board.excalidraw'), JSON.stringify(input.scene, null, 2)),
    );
  }
  if (input.review) {
    const rel = `.feedback/sketches/${basename(dir)}/images`;
    const files = new Map((input.images ?? []).map((img) => [basename(img.name).replace(/\.[^.]*$/, ''), basename(img.name)]));
    const picturePath = (id: string) => (files.has(id) ? `${rel}/${files.get(id)}` : undefined);
    writes.push(writeFile(join(dir, 'review.md'), reviewMarkdown(input.review, picturePath)));
  } else if (input.text || cleanSourcePath(input.sourcePath) || input.annotations) {
    writes.push(writeFile(join(dir, 'draft.md'), rewriteImages(input.text ?? '', basename(dir), input.images ?? [])));
  }
  if (input.annotations && !input.review) {
    const draftFile = `.feedback/sketches/${basename(dir)}/draft.md`;
    writes.push(writeFile(join(dir, 'annotations.md'), annotationsMarkdown(input.annotations, draftFile, cleanSourcePath(input.sourcePath))));
  }
  if (input.comments && input.png) writes.push(writeFile(join(dir, 'comments.md'), boardCommentsMarkdown(input.boardName, input.comments)));
  if (input.notes) writes.push(writeFile(join(dir, 'notes.md'), input.notes));
  if (input.timelineMd) writes.push(writeFile(join(dir, 'timeline.md'), input.timelineMd));
  if (input.transcript !== undefined) {
    writes.push(writeFile(join(dir, 'transcript.json'), JSON.stringify(input.transcript, null, 2)));
  }
  if (input.audio?.length) {
    await mkdir(join(dir, 'audio'), { recursive: true });
    for (const clip of input.audio) {
      writes.push(writeFile(join(dir, 'audio', basename(clip.name)), clip.data));
    }
  }
  if (input.images?.length) {
    await mkdir(join(dir, 'images'), { recursive: true });
    for (const img of input.images) writes.push(writeFile(join(dir, 'images', basename(img.name)), img.data));
  }
  await Promise.all(writes);
}
