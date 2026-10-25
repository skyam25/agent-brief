/** Each session's name as Claude Code titles it in its transcript: the user's rename, else Claude Code's own title. */

import { access, open, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Read size per step. A longer line, such as an inlined image, is skipped, since title lines are short. */
const CHUNK = 1 << 20;

const TITLE_MARK = Buffer.from('-title"');

interface Seen {
  path?: string;
  /** Every project folder was searched once for this transcript. */
  isSearched?: boolean;
  /** Bytes read so far, always at a line start. */
  offset: number;
  ai?: string;
  custom?: string;
}

export interface Titles {
  ai?: string;
  custom?: string;
}

/** Claude Code's folder name for a project's transcripts. Each character other than a letter or digit becomes `-`. */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/** The last `ai-title` and `custom-title` in some transcript lines. */
export function titlesIn(text: string, into: Titles = {}): Titles {
  for (const line of text.split('\n')) {
    if (!line.includes('-title"')) continue;
    try {
      const o = JSON.parse(line) as { type?: unknown; aiTitle?: unknown; customTitle?: unknown };
      if (o.type === 'ai-title' && typeof o.aiTitle === 'string' && o.aiTitle.trim()) into.ai = o.aiTitle.trim();
      if (o.type === 'custom-title' && typeof o.customTitle === 'string' && o.customTitle.trim()) into.custom = o.customTitle.trim();
    } catch {
      // A partial line names nothing.
    }
  }
  return into;
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

export class SessionNames {
  private readonly seen = new Map<string, Seen>();
  /** Updates run one at a time, so two never read the same bytes. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly root = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects')) {}

  /** The session's rename, else Claude Code's title. Undefined until a transcript names it. */
  name(sessionId: string): string | undefined {
    const s = this.seen.get(sessionId);
    return s?.custom ?? s?.ai;
  }

  /** Reads what each session's transcript gained since the last call. Resolves true when a name changed. */
  update(sessions: { sessionId: string; cwd?: string }[]): Promise<boolean> {
    const run = this.queue.then(() => this.readAll(sessions));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async readAll(sessions: { sessionId: string; cwd?: string }[]): Promise<boolean> {
    let changed = false;
    for (const s of sessions) {
      const before = this.name(s.sessionId);
      await this.read(s.sessionId, s.cwd).catch(() => undefined);
      if (this.name(s.sessionId) !== before) changed = true;
    }
    return changed;
  }

  /** Forgets sessions the panel no longer lists. */
  keepOnly(ids: string[]): void {
    for (const id of this.seen.keys()) if (!ids.includes(id)) this.seen.delete(id);
  }

  private async read(sessionId: string, cwd: string | undefined): Promise<void> {
    const seen = this.seen.get(sessionId) ?? { offset: 0 };
    this.seen.set(sessionId, seen);
    seen.path ??= await this.find(sessionId, cwd, seen);
    if (!seen.path) return;
    const size = (await stat(seen.path)).size;
    if (size < seen.offset) Object.assign(seen, { offset: 0, ai: undefined, custom: undefined });
    if (size === seen.offset) return;
    const file = await open(seen.path, 'r');
    try {
      const buf = Buffer.alloc(CHUNK);
      while (seen.offset < size) {
        const { bytesRead } = await file.read(buf, 0, Math.min(CHUNK, size - seen.offset), seen.offset);
        if (bytesRead === 0) break;
        const end = buf.subarray(0, bytesRead).lastIndexOf(0x0a);

        // A line still being written waits for the next read. One longer than a chunk is skipped.
        if (end === -1) {
          if (bytesRead < CHUNK) break;
          seen.offset += bytesRead;
          continue;
        }
        const lines = buf.subarray(0, end + 1);
        if (lines.includes(TITLE_MARK)) titlesIn(lines.toString('utf8'), seen);
        seen.offset += end + 1;
      }
    } finally {
      await file.close();
    }
  }

  /** The transcript under the folder's own project, else under any project. Each session searches all of them once. */
  private async find(sessionId: string, cwd: string | undefined, seen: Seen): Promise<string | undefined> {
    const file = `${sessionId}.jsonl`;
    if (cwd) {
      const path = join(this.root, projectSlug(cwd), file);
      if (await exists(path)) return path;
    }
    if (seen.isSearched) return undefined;
    seen.isSearched = true;
    const dirs = await readdir(this.root).catch(() => [] as string[]);
    for (const dir of dirs) {
      const path = join(this.root, dir, file);
      if (await exists(path)) return path;
    }
    return undefined;
  }
}
