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
  /** The start under way, which a second press joins instead of opening another microphone. */
  private opening?: Promise<void>;
  private current?: MediaRecorder;
  private generation = 0;
  private sequence = 0;
  private rotateTimer?: ReturnType<typeof setTimeout>;
  private pending: Promise<void>[] = [];
  private listeners = new Set<() => void>();
  /** Epoch ms when the current recording began. */
  since?: number;
  /** Audio kept in saved segments, across every recording since the last clear. */
  recordedMs = 0;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly segmentMs = SEGMENT_MS,
  ) {}

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
    for (const fn of this.listeners) fn();
  }

  start(): Promise<void> {
    if (this.stream) return Promise.resolve();
    this.opening ??= this.open().finally(() => (this.opening = undefined));
    return this.opening;
  }

  private async open(): Promise<void> {
    const generation = this.generation;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (generation !== this.generation) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }
    this.stream = stream;
    this.since = this.now();
    this.startSegment();
    this.emit();
  }

  private startSegment(): void {
    const stream = this.stream!;
    const recorder = new MediaRecorder(stream, { mimeType: MIME });
    const chunks: Blob[] = [];
    const startedAt = this.now();
    const name = `seg-${this.sequence++}.webm`;
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
    this.generation++;
    clearTimeout(this.rotateTimer);
    if (this.current && this.current.state !== 'inactive') this.current.stop();
    this.current = undefined;
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    if (this.since !== undefined) this.recordedMs += this.now() - this.since;
    this.stream = undefined;
    this.since = undefined;
    await Promise.all(this.pending);
    this.emit();
  }

  /** Clears a completed Send's clips without dropping a newer take. */
  consume(sent: readonly RecordedSegment[], recordedMs: number): void {
    const delivered = new Set(sent);
    const kept = this.segments.filter((s) => !delivered.has(s));
    this.segments.splice(0, this.segments.length, ...kept);
    this.recordedMs = Math.max(0, this.recordedMs - recordedMs);
    this.emit();
  }

  /** Forgets saved segments, after they were sent. */
  clear(): void {
    this.segments.length = 0;
    this.recordedMs = 0;
    this.emit();
  }

  /** Stops any recording and drops everything recorded. */
  async discard(): Promise<void> {
    await this.stop();
    this.clear();
  }
}
