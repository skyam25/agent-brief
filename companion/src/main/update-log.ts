/** Writes electron-updater's log to a file, so a failed check can be traced later. */

import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

const MAX_BYTES = 512 * 1024;

export interface UpdateLog {
  info(message: unknown): void;
  warn(message: unknown): void;
  error(message: unknown): void;
}

/** Appends timestamped lines and keeps one older file at `<path>.1`. */
export function fileLog(path: string, now = () => new Date()): UpdateLog {
  const write = (level: string, message: unknown) => {
    const text = message instanceof Error ? (message.stack ?? message.message) : String(message);
    try {
      mkdirSync(dirname(path), { recursive: true });
      if ((statSync(path, { throwIfNoEntry: false })?.size ?? 0) > MAX_BYTES) renameSync(path, `${path}.1`);
      appendFileSync(path, `${now().toISOString()} ${level} ${text}\n`);
    } catch {
      // A log that can't be written never stops an update.
    }
  };
  return { info: (m) => write('info', m), warn: (m) => write('warn', m), error: (m) => write('error', m) };
}
