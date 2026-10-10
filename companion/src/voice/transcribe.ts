/**
 * Local transcription of voice segments. ffmpeg converts each WebM clip to
 * 16 kHz mono WAV, yap transcribes it, and the sentences land on the session clock.
 */

import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { promisify } from 'node:util';
import type { Utterance, VoiceSegment } from './types';

/** Runs a program to completion. Tests replace it. */
export type RunProcess = (cmd: string, args: string[]) => Promise<void>;

export interface TranscribeOptions {
  ffmpegPath: string;
  yapPath: string;
  /** Scratch folder. Files for each segment are removed after use. */
  tmpDir: string;
  run?: RunProcess;
  /** Called when a segment fails. The other segments still run. */
  onError?: (segment: string, message: string) => void;
}

const TIMEOUT_MS = 5 * 60_000;
const execFileAsync = promisify(execFile);

const defaultRun: RunProcess = async (cmd, args) => {
  await execFileAsync(cmd, args, { timeout: TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

export interface Sentence {
  t: number;
  tEnd: number;
  text: string;
}

/**
 * Reads yap's `--json` output. yap times are float seconds from the file
 * start and each segment is one sentence. `offsetMs` moves them onto the session clock.
 */
export function parseYap(json: unknown, offsetMs: number): Sentence[] {
  if (!isRecord(json) || !Array.isArray(json.segments)) {
    throw new Error('yap output has no segments array');
  }
  const out: Sentence[] = [];
  for (const seg of json.segments) {
    if (!isRecord(seg)) continue;
    const text = typeof seg.text === 'string' ? seg.text.trim() : '';
    const start = num(seg.start);
    if (!text || start === undefined) continue;
    const end = num(seg.end) ?? start;
    out.push({
      t: Math.round(offsetMs + start * 1000),
      tEnd: Math.round(offsetMs + end * 1000),
      text,
    });
  }
  return out;
}

function messageOf(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { stderr?: unknown; message?: unknown };
    const stderr = typeof e.stderr === 'string' ? e.stderr.trim() : '';
    if (stderr) return stderr.split('\n').slice(-3).join(' ').slice(0, 400);
    if (typeof e.message === 'string') return e.message.slice(0, 400);
  }
  return String(err);
}

async function transcribeOne(segment: VoiceSegment, opts: TranscribeOptions): Promise<Utterance[]> {
  const run = opts.run ?? defaultRun;
  const stem = join(opts.tmpDir, basename(segment.name, extname(segment.name)));
  const input = `${stem}.in${extname(segment.name) || '.webm'}`;
  const wav = `${stem}.wav`;
  const json = `${stem}.json`;
  try {
    await writeFile(input, segment.data);
    await run(opts.ffmpegPath, ['-y', '-loglevel', 'error', '-i', input, '-ar', '16000', '-ac', '1', wav]);
    await run(opts.yapPath, ['transcribe', '--json', '--word-timestamps', '--max-length', '400', '-o', json, wav]);
    const sentences = parseYap(JSON.parse(await readFile(json, 'utf8')), segment.startMs);
    return sentences.map((s) => ({
      ...s,
      audio: `audio/${basename(segment.name)}`,
      audioStart: segment.startMs,
    }));
  } finally {
    await Promise.all([input, wav, json].map((f) => rm(f, { force: true })));
  }
}

/** One utterance per sentence, in session-time order. */
export async function transcribe(
  segments: VoiceSegment[],
  opts: TranscribeOptions,
): Promise<Utterance[]> {
  await mkdir(opts.tmpDir, { recursive: true });
  const out: Utterance[] = [];
  for (const segment of segments) {
    try {
      out.push(...(await transcribeOne(segment, opts)));
    } catch (err) {
      opts.onError?.(segment.name, messageOf(err));
    }
  }
  return out.sort((a, b) => a.t - b.t);
}
