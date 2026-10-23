/**
 * Voice for the review pane. The words belong to a target: a comment, or the overall note.
 *
 * Live dictation hands over each phrase a few seconds after a pause, and the phrase goes to
 * the target the voice pointed at when it began. Without it, one clip records at a time.
 * Pointing at another target ends the clip, and the clip turns into text for its own target.
 */

import type { CompanionApi } from '../shared/ipc';

/** The overall note, as a voice target. */
export const OVERALL = '';

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

/** Live dictation, where yap hears the microphone itself. */
export interface LiveDictation {
  /** Starts listening. Undefined when live dictation is unavailable, so clips take over. */
  start(onPhrase: (text: string, atMs: number) => void, onEnd: (error?: string) => void): Promise<LiveSession | undefined>;
}

/** Live dictation through main, which runs `yap dictate`. */
export function hostDictation(host: Pick<CompanionApi, 'startDictation' | 'stopDictation' | 'onDictation'>): LiveDictation {
  return {
    async start(onPhrase, onEnd) {
      const started = await host.startDictation();
      if (!('id' in started)) return undefined;
      let finish = () => {};
      const ended = new Promise<void>((resolve) => (finish = resolve));

      // Events follow the start reply, so nothing arrives before this listens.
      const off = host.onDictation((e) => {
        if (e.id !== started.id) return;
        if ('phrase' in e) onPhrase(e.phrase.text, e.phrase.atMs);
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
    const stream = (this.stream = await this.media.open());
    this.since = this.now();
    this.target = target;
    const aims = (this.aims = [{ at: this.since, target }]);
    let live: LiveSession | undefined;
    try {
      live = await this.opts.dictate?.start(
        (text, at) => this.heard(aims, text, at),
        (error) => {
          if (error) this.opts.onError(error);
          if (live && this.live === live) void this.stop();
        },
      );
    } catch (err) {
      this.opts.onError((err as Error).message);
    }

    // A stop while dictation started leaves nothing to listen for.
    if (this.stream !== stream) {
      void live?.stop();
      return;
    }
    this.live = live;
    if (!live) this.begin();
    this.emit();
  }

  /** Points the words at `target`. While recording clips, the clip so far goes to the old one. */
  aim(target: string): void {
    if (target === this.target) return;
    this.target = target;
    if (this.live) this.aims.push({ at: this.now(), target });
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
      this.emit();
    }
    await Promise.all([...this.inflight]);
  }

  /** A live phrase goes to the target the voice pointed at when it began. */
  private heard(aims: { at: number; target: string }[], text: string, at: number): void {
    let target = aims[0]!.target;
    for (const a of aims) if (a.at <= at) target = a.target;
    if (text.trim()) this.opts.onText(target, text.trim());
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
