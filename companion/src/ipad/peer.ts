/**
 * The peer-to-peer route through `agent-brief-peer`, a small Swift program that advertises the LAN API over
 * Apple peer-to-peer Wi-Fi and passes raw TCP to the listener on 127.0.0.1. TLS stays between the phone and the listener.
 *
 * The helper takes `--name <instance> --port <port>`. It prints `ready` once it advertises, or `failed: <reason>`
 * and exits nonzero. It exits when its stdin closes or on SIGTERM, and exits nonzero if the listener fails later.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

export type PeerStart = { ok: true } | { ok: false; error: string };

export interface PeerOptions {
  /** The helper's command line, before `--name` and `--port`. */
  argv: readonly string[];
  /** Fires when the route drops or comes back on its own, between `start` and `stop`. */
  onChange?(up: boolean): void;
  /** How long a launch waits for `ready`. */
  readyMs?: number;
  /** The wait before each restart. Its length caps the restarts in a row. */
  backoffMs?: readonly number[];
  /** How long a helper must stay up before the restart count starts over. */
  stableMs?: number;
  /** How long `stop` waits before it kills the helper outright. */
  stopMs?: number;
}

/** How much of the helper's stderr a failure can quote. */
const TAIL = 400;

/** One helper process. */
class Run {
  private readonly child: ChildProcessWithoutNullStreams;
  private stderr = '';
  private failure?: string;
  private settle!: (result: PeerStart) => void;
  private closed = false;
  /** Why the helper ended, once it has. */
  reason?: string;
  readonly ready: Promise<PeerStart>;
  readonly exited: Promise<void>;

  constructor(argv: readonly string[], readyMs: number) {
    this.ready = new Promise((resolve) => (this.settle = resolve));
    this.child = spawn(argv[0]!, argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdin.on('error', () => {});
    let buf = '';
    this.child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      buf += chunk;
      for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
        this.line(buf.slice(0, nl).trim());
        buf = buf.slice(nl + 1);
      }
    });
    this.child.stderr.setEncoding('utf8').on('data', (chunk: string) => (this.stderr = (this.stderr + chunk).slice(-TAIL)));
    const timer = setTimeout(() => {
      this.settle({ ok: false, error: `no ready line in ${readyMs} ms` });
      this.kill('SIGTERM');
    }, readyMs);
    this.exited = new Promise((resolve) => {
      this.child.on('error', (err) => {
        this.closed = true;
        clearTimeout(timer);
        this.reason = this.failure ?? err.message;
        this.settle({ ok: false, error: this.reason });
        resolve();
      });
      this.child.on('close', (code, signal) => {
        this.closed = true;
        clearTimeout(timer);
        this.reason = this.failure ?? (this.stderr.trim().split('\n').pop() || (signal ? `killed by ${signal}` : `exit code ${code}`));
        this.settle({ ok: false, error: this.reason });
        resolve();
      });
    });
    void this.ready.then(() => clearTimeout(timer));
  }

  /** Ends stdin and SIGTERM, then SIGKILL if the helper is still there after `stopMs`. */
  async stop(stopMs: number): Promise<void> {
    this.child.stdin.end();
    this.kill('SIGTERM');
    const timer = setTimeout(() => this.kill('SIGKILL'), stopMs);
    await this.exited;
    clearTimeout(timer);
  }

  // A spawn that failed has no pid, and killing it would signal this whole process group.
  kill(signal: NodeJS.Signals): void {
    if (!this.closed && this.child.pid !== undefined) this.child.kill(signal);
  }

  private line(text: string): void {
    if (text === 'ready') this.settle({ ok: true });
    else if (text.startsWith('failed:')) this.failure = text.slice('failed:'.length).trim() || 'failed';
  }
}

/** Keeps one helper running between `start` and `stop`, restarting it a few times if it dies. */
export class Peer {
  private run?: Run;
  private target?: { name: string; port: number };
  private restarts = 0;
  private timer?: NodeJS.Timeout;
  private stable?: NodeJS.Timeout;
  private generation = 0;
  private live = false;
  private lastError?: string;
  private readonly readyMs: number;
  private readonly backoffMs: readonly number[];
  private readonly stableMs: number;
  private readonly stopMs: number;

  constructor(private readonly opts: PeerOptions) {
    this.readyMs = opts.readyMs ?? 5_000;
    this.backoffMs = opts.backoffMs ?? [500, 2_000, 5_000];
    this.stableMs = opts.stableMs ?? 60_000;
    this.stopMs = opts.stopMs ?? 2_000;
  }

  /** Whether the helper reported `ready` and still runs. */
  get up(): boolean {
    return this.live;
  }

  /** Why the last launch failed or the last helper died. */
  get error(): string | undefined {
    return this.lastError;
  }

  /** Starts the helper for this name and port, replacing any running one. Never rejects. */
  async start(name: string, port: number): Promise<PeerStart> {
    await this.stop();
    this.target = { name, port };
    return this.launch(this.generation);
  }

  /** Ends the helper and any pending restart. */
  async stop(): Promise<void> {
    this.generation++;
    clearTimeout(this.timer);
    clearTimeout(this.stable);
    this.restarts = 0;
    this.live = false;
    const run = this.run;
    this.run = undefined;
    await run?.stop(this.stopMs);
  }

  private async launch(generation: number): Promise<PeerStart> {
    const { name, port } = this.target!;
    const run = new Run([...this.opts.argv, '--name', name, '--port', String(port)], this.readyMs);
    this.run = run;
    const result = await run.ready;
    if (generation !== this.generation) {
      await run.stop(this.stopMs);
      return { ok: false, error: 'stopped' };
    }
    if (!result.ok) {
      this.lastError = result.error;
      this.run = undefined;
      await run.stop(this.stopMs);
      return result;
    }
    this.live = true;
    this.lastError = undefined;
    this.stable = setTimeout(() => (this.restarts = 0), this.stableMs);
    void run.exited.then(() => this.died(run, generation));
    return result;
  }

  /** A helper that exits while it should run comes back after a backoff, until the cap. */
  private died(run: Run, generation: number): void {
    if (generation !== this.generation || this.run !== run) return;
    this.run = undefined;
    clearTimeout(this.stable);
    this.lastError = run.reason;
    if (this.live) {
      this.live = false;
      this.opts.onChange?.(false);
    }
    this.retry(generation);
  }

  private retry(generation: number): void {
    const wait = this.backoffMs[this.restarts];
    if (wait === undefined) return;
    this.restarts++;
    this.timer = setTimeout(() => {
      void this.launch(generation).then((r) => {
        if (generation !== this.generation) return;
        if (r.ok) this.opts.onChange?.(true);
        else this.retry(generation);
      });
    }, wait);
  }
}
