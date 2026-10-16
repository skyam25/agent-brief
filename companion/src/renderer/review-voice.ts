/**
 * Voice for the review pane. One clip records at a time, and each clip belongs to
 * a target: a comment, or the overall note. Pointing the voice at another target
 * ends the clip, and the finished clip turns into text for the target it belonged to.
 */

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

export interface ReviewVoiceOptions {
  transcribe(clip: Clip): Promise<{ text: string } | { error: string }>;
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
  private clip?: { recorder: ClipRecorder; target: string; startedAt: number };
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

  async start(target: string): Promise<void> {
    if (this.stream) return;
    this.stream = await this.media.open();
    this.since = this.now();
    this.target = target;
    this.begin();
    this.emit();
  }

  /** Points the words at `target`. While recording, the clip so far goes to the old one. */
  aim(target: string): void {
    if (target === this.target) return;
    this.target = target;
    if (this.stream) {
      this.finish();
      this.begin();
    }
    this.emit();
  }

  /** Closes the microphone. The last clip still turns into text. */
  async stop(): Promise<void> {
    if (!this.stream) return;
    const done = this.finish();
    this.media.close(this.stream);
    this.stream = undefined;
    this.since = undefined;
    this.emit();
    await done;
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
    this.pending.set(clip.target, (this.pending.get(clip.target) ?? 0) + 1);
    this.emit();
    try {
      const result = await this.opts.transcribe(audio);
      if ('error' in result) this.opts.onError(result.error);
      else if (result.text.trim()) this.opts.onText(clip.target, result.text.trim());
    } catch (err) {
      this.opts.onError((err as Error).message);
    } finally {
      const left = (this.pending.get(clip.target) ?? 1) - 1;
      if (left > 0) this.pending.set(clip.target, left);
      else this.pending.delete(clip.target);
      this.emit();
    }
  }
}
