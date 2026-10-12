/** Builds the app's DeliveryInput from a finished sketch session. */

import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { DeliveryInput } from '../server/contract';
import { stackNames, type StackElement } from '../board/stack';
import { buildTimeline } from './timeline';
import { transcribe, type TranscribeOptions } from './transcribe';
import type { StrokeEvent, VoiceSegment } from './types';

export interface ComposeInput {
  boardName: string;
  png: Buffer;
  /** Full Excalidraw scene JSON. */
  scene: unknown;
  notes?: string;
  /** A written draft that leads the prompt. */
  text?: string;
  strokes: StrokeEvent[];
  segments: VoiceSegment[];
  /** The board's bounding box, for position words. */
  bounds: { x: number; y: number; width: number; height: number };
  mode?: 'fill' | 'submit';
  sessionId?: string;
  transcribe: TranscribeOptions;
}

export async function composeDelivery(input: ComposeInput): Promise<DeliveryInput> {
  const utterances =
    input.segments.length > 0 ? await transcribe(input.segments, input.transcribe) : [];
  const hasTimeline = input.strokes.length > 0 || utterances.length > 0;
  const timeline = hasTimeline
    ? buildTimeline({
        strokes: input.strokes,
        utterances,
        bounds: input.bounds,
        images: imagesIn(input.scene),
        imageNames: stackNames(((input.scene as { elements?: StackElement[] } | null)?.elements ?? []) as StackElement[]),
        boardName: input.boardName,
      })
    : undefined;

  return {
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    png: input.png,
    scene: input.scene,
    boardName: input.boardName,
    ...(input.notes ? { notes: input.notes } : {}),
    ...(input.text ? { text: input.text } : {}),
    ...(timeline ? { timelineMd: timeline.timelineMd } : {}),
    ...(timeline && timeline.transcript.length > 0 ? { transcript: timeline.transcript } : {}),
    ...(timeline?.speech ? { speech: timeline.speech } : {}),
    ...(input.segments.length > 0
      ? { audio: input.segments.map((s) => ({ name: s.name, data: s.data })) }
      : {}),
    ...(input.mode ? { mode: input.mode } : {}),
  };
}

/** Boxes of the live images in an Excalidraw scene. */
function imagesIn(scene: unknown): { x: number; y: number; width: number; height: number }[] {
  const elements = (scene as { elements?: unknown[] } | null)?.elements;
  if (!Array.isArray(elements)) return [];
  return elements
    .filter((e): e is { x: number; y: number; width: number; height: number } => {
      const el = e as { type?: string; isDeleted?: boolean };
      return el?.type === 'image' && !el.isDeleted;
    })
    .map(({ x, y, width, height }) => ({ x, y, width, height }));
}

const FIXED_DIRS = ['/opt/homebrew/bin', '/usr/local/bin'];

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Finds a command-line tool. A packaged app has no shell PATH, so it checks the
 * Homebrew folders first and then the PATH entries. `dirs` replaces that list.
 */
export function findTool(
  name: string,
  dirs: readonly string[] = [...FIXED_DIRS, ...(process.env.PATH ?? '').split(delimiter)],
): string | undefined {
  for (const dir of dirs) {
    if (!dir) continue;
    const path = join(dir, name);
    if (isExecutableFile(path)) return path;
  }
  return undefined;
}
