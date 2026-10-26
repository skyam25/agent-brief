/**
 * Live dictation. `yap dictate --json` listens to the microphone and prints each phrase once it settles,
 * a few seconds after a pause. Its times count from launch, so a phrase's start lands on the wall clock.
 * Speech without a pause arrives as one phrase. Word times let the renderer split it where the voice moved.
 *
 * SIGINT makes yap print the phrase in progress and exit; SIGTERM drops it.
 */

import { execFile, spawn } from 'node:child_process';

export interface DictationWord {
  text: string;
  /** Epoch ms when the word began. */
  atMs: number;
}

export interface DictationPhrase {
  text: string;
  /** Epoch ms when the phrase began. */
  atMs: number;
  /** The phrase's words in order, with its punctuation. Absent when yap gave no word times. */
  words?: DictationWord[];
}

interface Segment {
  start: number;
  text: string;
  words?: { start: number; text: string }[];
}

export interface DictationOptions {
  argv: readonly string[];
  onPhrase(phrase: DictationPhrase): void;
  /** Fires once, when yap exits. `error` says why when it failed. */
  onEnd(error?: string): void;
  now?: () => number;
}

export interface Dictation {
  /** Asks yap for the phrase in progress and resolves once it has exited. */
  stop(): Promise<void>;
  /** Ends yap at once and drops what it has not printed. */
  kill(): void;
}

export function startDictation({ argv, onPhrase, onEnd, now = Date.now }: DictationOptions): Dictation {
  const startedAt = now();
  const child = spawn(argv[0]!, argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
  const reader = new SegmentReader();
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    for (const s of reader.push(chunk)) {
      const phrase = toPhrase(s, startedAt);
      if (phrase) onPhrase(phrase);
    }
  });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));

  let ended = false;
  const exited = new Promise<void>((resolve) => {
    const end = (error?: string) => {
      if (ended) return;
      ended = true;
      onEnd(error);
      resolve();
    };
    child.on('error', (err) => end(`Dictation failed: ${err.message}`));
    child.on('close', (code, signal) => end(code === 0 || signal !== null ? undefined : failureText(stderr, code)));
  });

  // A spawn that failed has no pid, and killing it would signal this whole process group.
  const running = () => !ended && child.pid !== undefined && child.exitCode === null && child.signalCode === null;
  return {
    stop: () => {
      if (running()) child.kill('SIGINT');
      return exited;
    },
    kill: () => {
      if (running()) child.kill('SIGTERM');
    },
  };
}

function toPhrase(s: Segment, startedAt: number): DictationPhrase | undefined {
  const text = s.text.trim();
  if (!text) return undefined;
  const at = (seconds: number) => startedAt + Math.round(seconds * 1000);
  const phrase: DictationPhrase = { text, atMs: at(s.start) };
  if (!s.words?.length) return phrase;

  // Word texts drop punctuation. Borrow the phrase's own tokens when they line up one to one.
  const tokens = text.split(/\s+/);
  const aligned = tokens.length === s.words.length;
  phrase.words = s.words.map((w, i) => ({ text: aligned ? tokens[i]! : w.text, atMs: at(w.start) }));
  return phrase;
}

/** Why yap failed, from the end of its stderr. */
function failureText(stderr: string, code: number | null): string {
  const why = stderr.trim().split('\n').slice(-2).join(' ').replace(/^Error: /, '').slice(0, 200);
  return `Dictation failed: ${why || `exit code ${code}`}`;
}

/** Reads yap's streamed JSON, handing over each segment once its closing brace arrives. */
export class SegmentReader {
  private buf = '';
  /** Where scanning resumes. -1 until the segments array opens. */
  private at = -1;
  private depth = 0;
  private start = 0;
  private inString = false;
  private escaped = false;

  push(chunk: string): Segment[] {
    this.buf += chunk;
    const found: Segment[] = [];
    if (this.at < 0) {
      const key = this.buf.indexOf('"segments"');
      const open = key < 0 ? -1 : this.buf.indexOf('[', key);
      if (open < 0) return found;
      this.at = open + 1;
    }
    for (; this.at < this.buf.length; this.at++) {
      const c = this.buf[this.at];
      if (this.inString) {
        if (this.escaped) this.escaped = false;
        else if (c === '\\') this.escaped = true;
        else if (c === '"') this.inString = false;
      } else if (c === '"') this.inString = true;
      else if (c === '{' && this.depth++ === 0) this.start = this.at;
      else if (c === '}' && --this.depth === 0) {
        const segment = JSON.parse(this.buf.slice(this.start, this.at + 1)) as { start?: unknown; text?: unknown; words?: unknown };
        if (typeof segment.text !== 'string' || typeof segment.start !== 'number') continue;
        const words = Array.isArray(segment.words) ? segment.words.filter(isWord) : [];
        found.push({ start: segment.start, text: segment.text, ...(words.length ? { words } : {}) });
      }
    }
    return found;
  }
}

const isWord = (w: unknown): w is { start: number; text: string } =>
  typeof (w as { start?: unknown })?.start === 'number' && typeof (w as { text?: unknown })?.text === 'string';

const argvs = new Map<string, Promise<string[] | undefined>>();

/** The `yap dictate` command line, or undefined when this yap only transcribes files. Word times need a newer yap. */
export function dictateArgv(yapPath: string): Promise<string[] | undefined> {
  let known = argvs.get(yapPath);
  if (!known) {
    known = new Promise((resolve) =>
      execFile(yapPath, ['dictate', '--help'], { timeout: 10_000 }, (err, stdout) => {
        if (err) return resolve(undefined);
        const words = String(stdout).includes('--word-timestamps') ? ['--word-timestamps'] : [];
        resolve([yapPath, 'dictate', '--json', '--max-length', '400', ...words]);
      }),
    );
    argvs.set(yapPath, known);
  }
  return known;
}
