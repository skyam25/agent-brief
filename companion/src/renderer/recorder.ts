/**
 * Records the microphone as WebM/Opus in 30 s segments. Each segment is a
 * separate recording, so every file decodes on its own.
 */

export const SEGMENT_MS = 30_000;
const MIME = 'audio/webm;codecs=opus';

export interface RecordedSegment {
  name: string;
  data: Uint8Array;
  /** Epoch ms when this segment's audio starts. */
  startedAt: number;
  mimeType: string;
}

export class Recorder {
  readonly segments: RecordedSegment[] = [];
  private stream?: MediaStream;
  private current?: MediaRecorder;
  private rotateTimer?: ReturnType<typeof setTimeout>;
  private pending: Promise<void>[] = [];
  private listeners = new Set<() => void>();
  /** Epoch ms when the current recording began. */
  since?: number;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly segmentMs = SEGMENT_MS,
  ) {}

  get recording(): boolean {
    return this.stream !== undefined;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  async start(): Promise<void> {
    if (this.stream) return;
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.since = this.now();
    this.startSegment();
    this.emit();
  }

  private startSegment(): void {
    const stream = this.stream!;
    const recorder = new MediaRecorder(stream, { mimeType: MIME });
    const chunks: Blob[] = [];
    const startedAt = this.now();
    const name = `seg-${this.segments.length + this.pending.length}.webm`;
    const done = new Promise<void>((resolve) => {
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };
      recorder.onstop = async () => {
        const blob = new Blob(chunks, { type: MIME });
        if (blob.size > 0) {
          this.segments.push({ name, data: new Uint8Array(await blob.arrayBuffer()), startedAt, mimeType: MIME });
          this.segments.sort((a, b) => a.startedAt - b.startedAt);
        }
        resolve();
      };
    });
    this.pending.push(done);
    void done.then(() => {
      this.pending = this.pending.filter((p) => p !== done);
    });
    recorder.start();
    this.current = recorder;
    this.rotateTimer = setTimeout(() => {
      recorder.stop();
      if (this.stream) this.startSegment();
    }, this.segmentMs);
  }

  /** Stops recording and waits until every segment is saved. */
  async stop(): Promise<void> {
    clearTimeout(this.rotateTimer);
    if (this.current && this.current.state !== 'inactive') this.current.stop();
    this.current = undefined;
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = undefined;
    this.since = undefined;
    await Promise.all(this.pending);
    this.emit();
  }

  /** Forgets saved segments, after they were sent. */
  clear(): void {
    this.segments.length = 0;
  }
}
