/**
 * Voice for the review pane. The words belong to a target: a comment, or the overall note.
 *
 * Live dictation shows words as they are heard and settles them into phrases about a second after a pause.
 * Each word goes to the target the voice pointed at when the word began, so speech that runs on across a click
 * splits there. Without it, one clip records at a time.
 * Pointing at another target ends the clip, and the clip turns into text for its own target.
 */

import type { CompanionApi } from '../shared/ipc';

/** A heard word and the epoch ms it began. */
export interface HeardWord {
  text: string;
  atMs: number;
}

/** The overall note, as a voice target. */
export const OVERALL = '';

/** How far back a click's time counts, enough for the pane to catch up after the click. */
const AIM_LAG_MS = 2000;

/** Clips shorter than this hold no words worth sending to yap. */
const SHORTEST_MS = 700;
const MIME = 'audio/webm;codecs=opus';

export interface Clip {
  data: Uint8Array;
  mimeType: string;
}

/** One recording of the microphone. `stop` resolves with what it heard. */
export interface ClipRecorder {
  stop(): Promise<Clip>;
}

export interface VoiceMedia {
  /** Opens the microphone. */
  open(): Promise<MediaStream>;
  record(stream: MediaStream): ClipRecorder;
  close(stream: MediaStream): void;
}

const browserMedia: VoiceMedia = {
  open: () => navigator.mediaDevices.getUserMedia({ audio: true }),
  record(stream) {
    const recorder = new MediaRecorder(stream, { mimeType: MIME });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    recorder.start();
    return {
      stop: () =>
        new Promise((resolve) => {
          recorder.onstop = async () => resolve({ data: new Uint8Array(await new Blob(chunks, { type: MIME }).arrayBuffer()), mimeType: MIME });
          if (recorder.state === 'inactive') recorder.onstop(new Event('stop'));
          else recorder.stop();
        }),
    };
  },
  close: (stream) => {
    for (const track of stream.getTracks()) track.stop();
  },
};

/** A running live dictation. `stop` resolves once its last phrase is in. */
export interface LiveSession {
  stop(): Promise<void>;
}

/** Live dictation, where main's helper hears the microphone itself. */
export interface LiveDictation {
  /**
   * Starts listening. Undefined when live dictation is unavailable, so clips take over. `onReady` fires once the
   * microphone runs. `onLive` passes words still settling, each call replacing the last.
   */
  start(
    onPhrase: (text: string, atMs: number, words?: HeardWord[]) => void,
    onEnd: (error?: string) => void,
    onReady?: () => void,
    onLive?: (text: string, atMs: number, words?: HeardWord[]) => void,
  ): Promise<LiveSession | undefined>;
}

/** Live dictation through main, which runs the dictation helper. */
export function hostDictation(host: Pick<CompanionApi, 'startDictation' | 'stopDictation' | 'onDictation'>): LiveDictation {
  return {
    async start(onPhrase, onEnd, onReady, onLive) {
      const started = await host.startDictation();
      if (!('id' in started)) return undefined;
      let finish = () => {};
      const ended = new Promise<void>((resolve) => (finish = resolve));

      // Events follow the start reply, so nothing arrives before this listens.
      const off = host.onDictation((e) => {
        if (e.id !== started.id) return;
        if ('ready' in e) onReady?.();
        else if ('live' in e) onLive?.(e.live.text, e.live.atMs, e.live.words);
        else if ('phrase' in e) onPhrase(e.phrase.text, e.phrase.atMs, e.phrase.words);
        else {
          off?.();
          finish();
          onEnd(e.error);
        }
      });
      return {
        stop: async () => {
          await host.stopDictation(started.id);
          await ended;
        },
      };
    },
  };
}

export interface ReviewVoiceOptions {
  transcribe(clip: Clip): Promise<{ text: string } | { error: string }>;
  dictate?: LiveDictation;
  /** Words heard for a target. */
  onText(target: string, text: string): void;
  onError(message: string): void;
  media?: VoiceMedia;
  now?: () => number;
}

export class ReviewVoice {
  /** Epoch ms when the microphone opened. Undefined when off. */
  since?: number;
  /** The mic is on but dictation does not hear it yet, as while the speech model loads. */
  starting = false;
  /** Words still settling, by target. */
  settling = new Map<string, string>();
  /** Where the words go now. */
  target = OVERALL;
  /** Bumps on every change, as the snapshot React compares. */
  version = 0;
  /** Targets whose words are still turning into text. */
  readonly pending = new Map<string, number>();
  private stream?: MediaStream;
  /** The start under way, which a second press joins instead of opening another microphone. */
  private opening?: Promise<void>;
  private clip?: { recorder: ClipRecorder; target: string; startedAt: number };
  private live?: LiveSession;
  /** Where the voice pointed, and since when, while dictating live. */
  private aims: { at: number; target: string }[] = [];
  /** Finished clips still turning into text. */
  private readonly inflight = new Set<Promise<void>>();
  private readonly listeners = new Set<() => void>();
  private readonly media: VoiceMedia;
  private readonly now: () => number;

  constructor(private readonly opts: ReviewVoiceOptions) {
    this.media = opts.media ?? browserMedia;
    this.now = opts.now ?? Date.now;
  }

  get recording(): boolean {
    return this.stream !== undefined;
  }

  /** The open microphone, for a level meter. */
  get input(): MediaStream | undefined {
    return this.stream;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    this.version++;
    for (const fn of this.listeners) fn();
  }

  /** Opens the microphone, which also feeds the level meter, then listens live or records clips. */
  start(target: string): Promise<void> {
    if (this.stream) return Promise.resolve();
    this.opening ??= this.open(target).finally(() => (this.opening = undefined));
    return this.opening;
  }

  private async open(target: string): Promise<void> {
    this.target = target;
    const since = this.now();

    // A click while the mic opens moves the target from then on.
    const aims = (this.aims = [{ at: since, target }]);
    let heard = false;
    let live: LiveSession | undefined;

    // The level meter's microphone and dictation open together, since either can be slow.
    const dictating = (async () => {
      try {
        return await this.opts.dictate?.start(
          (text, at, words) => {
            if (this.aims === aims) this.settling = new Map();
            this.heard(aims, text, at, words);
          },
          (error) => {
            if (error) this.opts.onError(error);
            if (live && this.live === live) void this.stop();
          },
          () => {
            heard = true;
            if (this.aims !== aims || !this.starting) return;
            this.starting = false;
            this.emit();
          },
          (text, at, words) => {
            if (this.aims !== aims) return;
            this.settling = this.route(aims, text, at, words);
            this.emit();
          },
        );
      } catch (err) {
        this.opts.onError((err as Error).message);
        return undefined;
      }
    })();
    let stream: MediaStream;
    try {
      stream = this.stream = await this.media.open();
    } catch (err) {
      void (await dictating)?.stop();
      throw err;
    }
    this.since = since;
    this.starting = !!this.opts.dictate && !heard;
    this.emit();
    live = await dictating;

    // A stop while dictation started leaves nothing to listen for.
    if (this.stream !== stream) {
      void live?.stop();
      return;
    }
    this.live = live;
    if (!live) {
      this.starting = false;
      this.begin();
    }
    this.emit();
  }

  /**
   * Points the words at `target` from `at`, the epoch ms of the click that asked, when the caller knows it.
   * While recording clips, the clip so far goes to the old one.
   */
  aim(target: string, at = this.now()): void {
    if (target === this.target) return;
    this.target = target;

    // While dictation starts, the click still counts, from when it happened. A click time counts back at most
    // AIM_LAG_MS and never before the last aim, so aims stay in time order.
    if (this.live || this.opening) {
      const last = this.aims.at(-1)?.at ?? at;
      this.aims.push({ at: Math.max(at, last, this.now() - AIM_LAG_MS), target });
    }
    else if (this.stream) {
      this.track(this.finish());
      this.begin();
    }
    this.emit();
  }

  /** Closes the microphone, if open, and waits until every word has turned into text. */
  async stop(): Promise<void> {
    if (this.stream) {
      const live = this.live;
      this.live = undefined;
      if (live) this.track(this.pend(this.target, () => live.stop()));
      else this.track(this.finish());
      this.media.close(this.stream);
      this.stream = undefined;
      this.since = undefined;
      this.starting = false;
      this.settling = new Map();
      this.emit();
    }
    await Promise.all([...this.inflight]);
  }

  private heard(aims: { at: number; target: string }[], text: string, at: number, words?: HeardWord[]): void {
    for (const [target, said] of this.route(aims, text, at, words)) this.opts.onText(target, said);
    this.emit();
  }

  /** Each word goes to the target the voice pointed at when it began. Without word times, the whole phrase does. */
  private route(aims: { at: number; target: string }[], text: string, at: number, words?: HeardWord[]): Map<string, string> {
    const aimedAt = (ms: number) => {
      let target = aims[0]!.target;
      for (const a of aims) if (a.at <= ms) target = a.target;
      return target;
    };
    const runs: { target: string; words: string[] }[] = [];
    for (const w of words ?? []) {
      const target = aimedAt(w.atMs);
      if (runs.at(-1)?.target === target) runs.at(-1)!.words.push(w.text);
      else runs.push({ target, words: [w.text] });
    }

    // One run keeps the text as printed.
    if (runs.length < 2) return new Map(text.trim() ? [[runs[0]?.target ?? aimedAt(at), text.trim()]] : []);
    const routed = new Map<string, string>();
    for (const run of runs) routed.set(run.target, [routed.get(run.target), ...run.words].filter(Boolean).join(' '));
    return routed;
  }

  /** Marks `target` as still turning into text until `work` ends. */
  private async pend(target: string, work: () => Promise<void>): Promise<void> {
    this.pending.set(target, (this.pending.get(target) ?? 0) + 1);
    this.emit();
    try {
      await work();
    } finally {
      const left = (this.pending.get(target) ?? 1) - 1;
      if (left > 0) this.pending.set(target, left);
      else this.pending.delete(target);
      this.emit();
    }
  }

  private track(done: Promise<void>): void {
    this.inflight.add(done);
    const drop = () => this.inflight.delete(done);
    done.then(drop, drop);
  }

  private begin(): void {
    this.clip = { recorder: this.media.record(this.stream!), target: this.target, startedAt: this.now() };
  }

  private async finish(): Promise<void> {
    const clip = this.clip;
    this.clip = undefined;
    if (!clip) return;
    const short = this.now() - clip.startedAt < SHORTEST_MS;
    const audio = await clip.recorder.stop();
    if (short || audio.data.length === 0) return;
    await this.pend(clip.target, async () => {
      try {
        const result = await this.opts.transcribe(audio);
        if ('error' in result) this.opts.onError(result.error);
        else if (result.text.trim()) this.opts.onText(clip.target, result.text.trim());
      } catch (err) {
        this.opts.onError((err as Error).message);
      }
    });
  }
}
