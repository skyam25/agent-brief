/** Writes a delivery bundle under a session's project and builds its draft. */

import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
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

/** The prompt Claude Code receives. A written draft goes first, word for word, then the sketch lines. */
export function buildDraft(id: string, input: DeliveryInput): string {
  const text = input.text?.trim();
  if (!input.png) return text ?? '';
  const rel = `.feedback/sketches/${id}`;
  const lines = [`@${rel}/sketch.png`, `Sketch from the Agent Brief board "${input.boardName}".`];
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
  if (input.text) writes.push(writeFile(join(dir, 'draft.md'), input.text));
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
  await Promise.all(writes);
}
