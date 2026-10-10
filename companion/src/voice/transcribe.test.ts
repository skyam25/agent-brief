import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { parseYap, transcribe, type RunProcess } from './transcribe';
import { fileURLToPath } from 'node:url';
import type { VoiceSegment } from './types';

const YAP = {
  segments: [
    { text: ' This is the header. ', start: 0.5, end: 2.25, words: [] },
    { text: 'Then a button.', start: 3, end: 4.1 },
    { text: '   ', start: 5, end: 6 },
    { text: 'no start' },
    'junk',
  ],
};

describe('parseYap', () => {
  it('offsets seconds onto the session clock, one entry per sentence', () => {
    expect(parseYap(YAP, 30_000)).toEqual([
      { t: 30_500, tEnd: 32_250, text: 'This is the header.' },
      { t: 33_000, tEnd: 34_100, text: 'Then a button.' },
    ]);
  });

  it('uses start when end is missing', () => {
    expect(parseYap({ segments: [{ text: 'hi', start: 1 }] }, 0)).toEqual([
      { t: 1000, tEnd: 1000, text: 'hi' },
    ]);
  });

  it('rejects output without segments', () => {
    expect(() => parseYap({}, 0)).toThrow(/segments/);
    expect(() => parseYap(null, 0)).toThrow(/segments/);
  });
});

function fakeRun(log: string[][], speech: Record<string, unknown>): RunProcess {
  return async (cmd, args) => {
    log.push([cmd, ...args]);
    if (cmd === 'yap') {
      const wav = args[args.length - 1];
      const out = args[args.indexOf('-o') + 1];
      const key = wav.split('/').pop()!.replace('.wav', '');
      writeFileSync(out, JSON.stringify(speech[key]));
    }
  };
}

describe('transcribe', () => {
  const seg = (name: string, startMs: number): VoiceSegment => ({
    name,
    data: Buffer.from('x'),
    startMs,
    mimeType: 'audio/webm;codecs=opus',
  });

  it('offsets each segment, tags the audio and sorts by time', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'tr'));
    const log: string[][] = [];
    const run = fakeRun(log, {
      'seg-1': { segments: [{ text: 'second', start: 1, end: 2 }] },
      'seg-0': { segments: [{ text: 'first', start: 0, end: 1 }, { text: 'also', start: 2, end: 3 }] },
    });
    const out = await transcribe([seg('seg-1.webm', 30_000), seg('seg-0.webm', 0)], {
      ffmpegPath: 'ffmpeg',
      yapPath: 'yap',
      tmpDir,
      run,
    });
    expect(out).toEqual([
      { t: 0, tEnd: 1000, text: 'first', audio: 'audio/seg-0.webm', audioStart: 0 },
      { t: 2000, tEnd: 3000, text: 'also', audio: 'audio/seg-0.webm', audioStart: 0 },
      { t: 31_000, tEnd: 32_000, text: 'second', audio: 'audio/seg-1.webm', audioStart: 30_000 },
    ]);
    expect(log.map((c) => c[0])).toEqual(['ffmpeg', 'yap', 'ffmpeg', 'yap']);
    expect(log[0]).toContain('16000');
    expect(readdirSync(tmpDir)).toEqual([]);
  });

  it('reports a failed segment and keeps going', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'tr'));
    const errors: string[][] = [];
    const run: RunProcess = async (cmd, args) => {
      if (cmd === 'ffmpeg' && args.some((a) => a.includes('bad'))) throw new Error('bad audio');
      if (cmd === 'yap') {
        writeFileSync(args[args.indexOf('-o') + 1], JSON.stringify({ segments: [{ text: 'ok', start: 0 }] }));
      }
    };
    const out = await transcribe([seg('bad.webm', 0), seg('good.webm', 5000)], {
      ffmpegPath: 'ffmpeg',
      yapPath: 'yap',
      tmpDir,
      run,
      onError: (name, message) => errors.push([name, message]),
    });
    expect(out.map((u) => u.text)).toEqual(['ok']);
    expect(errors).toEqual([['bad.webm', 'bad audio']]);
  });
});

const FFMPEG = '/opt/homebrew/bin/ffmpeg';
const YAP_BIN = '/opt/homebrew/bin/yap';
const FIXTURE = fileURLToPath(new URL('../../e2e/fixtures/speech.wav', import.meta.url));
const haveTools = [FFMPEG, YAP_BIN, FIXTURE].every(existsSync);

describe.skipIf(!haveTools)('transcribe with ffmpeg and yap', () => {
  it('transcribes real speech', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'tr'));
    const webm = join(tmpDir, 'speech.webm');
    execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-i', FIXTURE, '-c:a', 'libopus', webm]);
    const data = await readFile(webm);
    const out = await transcribe([{ name: 'seg-0.webm', data, startMs: 5000, mimeType: 'audio/webm' }], {
      ffmpegPath: FFMPEG,
      yapPath: YAP_BIN,
      tmpDir: join(tmpDir, 'work'),
    });
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].t).toBeGreaterThanOrEqual(5000);
    expect(out[0].text.length).toBeGreaterThan(0);
    expect(out[0]).toMatchObject({ audio: 'audio/seg-0.webm', audioStart: 5000 });
  }, 120_000);
});
