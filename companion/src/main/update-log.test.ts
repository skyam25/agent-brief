import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fileLog } from './update-log';

describe('fileLog', () => {
  const at = () => new Date('2026-10-30T10:00:00Z');

  it('appends timestamped lines and creates the folder', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'update-log-')), 'logs', 'updater.log');
    const log = fileLog(path, at);
    log.info('Checking for update');
    log.warn(new Error('net::ERR_INTERNET_DISCONNECTED'));
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines[0]).toBe('2026-10-30T10:00:00.000Z info Checking for update');
    expect(lines[1]).toContain('warn Error: net::ERR_INTERNET_DISCONNECTED');
  });

  it('moves a full log aside', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'update-log-')), 'updater.log');
    writeFileSync(path, 'x'.repeat(600 * 1024));
    fileLog(path, at).error('boom');
    expect(readFileSync(path, 'utf8')).toBe('2026-10-30T10:00:00.000Z error boom\n');
    expect(readFileSync(`${path}.1`, 'utf8').length).toBe(600 * 1024);
  });
});
