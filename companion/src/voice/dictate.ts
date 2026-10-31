/**
 * Live dictation through `agent-brief-dictate`, a small Swift program on Apple's on-device speech engine.
 *
 * Each helper process serves one dictation. It loads the speech model at launch and waits for `start`,
 * so main keeps a loaded spare and a press only turns the microphone on.
 *
 * The helper prints one JSON object per line: `prepared`, `ready` once the microphone runs, `live` words
 * still settling, settled `phrase`s, or an `error`. Its times are epoch ms of the audio itself.
 * `stop` flushes the words in progress before the helper exits. Closing its stdin drops them.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

export interface DictationWord {
  text: string;
  /** Epoch ms when the word began. */
  atMs: number;
}

export interface DictationPhrase {
  text: string;
  /** Epoch ms when the phrase began. */
  atMs: number;
  /** The phrase's words in order, with their punctuation. */
  words?: DictationWord[];
}

export interface DictationHandlers {
  /** The microphone runs. Words said before this are not heard. */
  onReady?(): void;
  /** Words still settling. Each replaces the last, and a phrase clears them. */
  onLive?(phrase: DictationPhrase): void;
  onPhrase(phrase: DictationPhrase): void;
  /** Fires once, when the helper exits. `error` says why when it failed. */
  onEnd(error?: string): void;
}

export interface Dictation {
  /** Asks for the words in progress and resolves once the helper has exited. */
  stop(): Promise<void>;
  /** Ends the helper at once and drops what it has not printed. */
  kill(): void;
}

/** How long `stop` waits for the last words before it ends the helper. */
const STOP_MS = 5_000;

/** How much of the helper's stderr a failure message can quote. */
const TAIL = 400;

/** One helper process, loading or loaded until a dictation takes it. */
class Helper {
  private readonly child: ChildProcessWithoutNullStreams;
  private handlers?: DictationHandlers;
  private error?: string;
  private stderr = '';
  private ended = false;
  private exitedAt?: { code: number | null; signal: NodeJS.Signals | null };
  readonly exited: Promise<void>;

  constructor(argv: readonly string[]) {
    this.child = spawn(argv[0]!, argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdin.on('error', () => {});
    let buf = '';
    this.child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      buf += chunk;
      for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
        this.line(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    });
    this.child.stderr.setEncoding('utf8').on('data', (chunk: string) => (this.stderr = (this.stderr + chunk).slice(-TAIL)));
    this.exited = new Promise((resolve) => {
      this.child.on('error', (err) => {
        this.error ??= `Dictation failed: ${err.message}`;
        this.end();
        resolve();
      });
      this.child.on('close', (code, signal) => {
        this.exitedAt = { code, signal };
        if (code !== 0 && signal === null) this.error ??= `Dictation failed: ${this.stderr.trim().split('\n').pop() || `exit code ${code}`}`;
        this.end();
        resolve();
      });
    });
  }

  /** Still loading or loaded, and no dictation has taken it. */
  get alive(): boolean {
    return !this.ended && this.child.pid !== undefined && this.exitedAt === undefined;
  }

  /** Turns the microphone on. A helper still loading starts once it has loaded. */
  start(handlers: DictationHandlers): Dictation {
    this.handlers = handlers;
    if (this.ended) handlers.onEnd(this.error);
    else this.child.stdin.write('start\n');
    return {
      stop: async () => {
        if (!this.alive) return this.exited;
        this.child.stdin.write('stop\n');
        const timer = setTimeout(() => this.kill(), STOP_MS);
        await this.exited;
        clearTimeout(timer);
      },
      kill: () => this.kill(),
    };
  }

  // A spawn that failed has no pid, and killing it would signal this whole process group.
  kill(): void {
    if (this.alive) this.child.kill('SIGTERM');
  }

  private line(text: string): void {
    let e: { ready?: unknown; live?: unknown; phrase?: unknown; error?: unknown };
    try {
      e = JSON.parse(text) as typeof e;
    } catch {
      return;
    }
    if (typeof e.error === 'string') this.error = e.error;
    if (!this.handlers) return;
    if (e.ready === true) this.handlers.onReady?.();
    const live = toPhrase(e.live);
    if (live) this.handlers.onLive?.(live);
    const phrase = toPhrase(e.phrase);
    if (phrase) this.handlers.onPhrase(phrase);
  }

  private end(): void {
    if (this.ended) return;
    this.ended = true;
    this.handlers?.onEnd(this.error);
  }
}

function toPhrase(v: unknown): DictationPhrase | undefined {
  const p = v as { text?: unknown; atMs?: unknown; words?: unknown } | undefined;
  if (typeof p?.text !== 'string' || typeof p.atMs !== 'number' || !p.text.trim()) return undefined;
  const words = Array.isArray(p.words) ? p.words.filter(isWord).map((w) => ({ text: w.text, atMs: w.atMs })) : [];
  return { text: p.text.trim(), atMs: p.atMs, ...(words.length ? { words } : {}) };
}

const isWord = (w: unknown): w is DictationWord =>
  typeof (w as { atMs?: unknown })?.atMs === 'number' && typeof (w as { text?: unknown })?.text === 'string';

export interface DictatorOptions {
  /** The helper's command line, or undefined when there is no helper. */
  argv(): Promise<readonly string[] | undefined> | readonly string[] | undefined;
  /** Notes how long each start took to hear. */
  log?(line: string): void;
  now?: () => number;
}

/** Runs dictations, keeping a loaded helper ready for the next one. */
export class Dictator {
  private spare?: Helper;
  private disposed = false;
  private readonly now: () => number;

  constructor(private readonly opts: DictatorOptions) {
    this.now = opts.now ?? Date.now;
  }

  /** Loads a spare helper unless one is ready. */
  async warm(): Promise<void> {
    if (this.disposed || this.spare?.alive) return;
    const argv = await this.opts.argv();
    if (argv && !this.disposed && !this.spare?.alive) this.spare = new Helper(argv);
  }

  /** Dictates on the spare, or on a new helper. Undefined when there is no helper. */
  async start(handlers: DictationHandlers): Promise<Dictation | undefined> {
    const warm = this.spare?.alive === true;
    let helper = warm ? this.spare : undefined;
    this.spare = undefined;
    if (!helper) {
      const argv = await this.opts.argv();
      if (!argv) return undefined;
      helper = new Helper(argv);
    }
    const asked = this.now();
    let heard = false;
    return helper.start({
      ...handlers,
      onReady: () => {
        heard = true;
        this.opts.log?.(`mic on in ${this.now() - asked} ms (${warm ? 'spare' : 'cold'})`);
        handlers.onReady?.();
      },
      onEnd: (error) => {
        if (error) this.opts.log?.(`${heard ? 'ended' : 'never heard'}: ${error}`);
        handlers.onEnd(error);
        void this.warm();
      },
    });
  }

  /** Ends the spare. Running dictations end on their own. */
  dispose(): void {
    this.disposed = true;
    this.spare?.kill();
    this.spare = undefined;
  }
}
