import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCompanionServer } from '../server';
import { fakeBackend, request } from '../server/testkit';
import { composeDelivery, findTool } from './compose';
import type { RunProcess } from './transcribe';
import { fileURLToPath } from 'node:url';
import type { StrokeEvent, VoiceSegment } from './types';

const bounds = { x: 0, y: 0, width: 900, height: 900 };
const png = Buffer.from([1, 2, 3]);

const stroke = (t: number, over: Partial<StrokeEvent> = {}): StrokeEvent => ({
  t,
  tEnd: t + 200,
  elementId: `e${t}`,
  type: 'freedraw',
  bbox: { x: 10, y: 10, width: 50, height: 50 },
  by: 'user',
  kind: 'add',
  ...over,
});

const base = { boardName: 'main', png, scene: { elements: [] }, bounds };

function fakeTranscribe(text: string) {
  const run: RunProcess = async (cmd, args) => {
    if (cmd === 'yap') {
      writeFileSync(
        args[args.indexOf('-o') + 1],
        JSON.stringify({ segments: [{ text, start: 1, end: 2 }] }),
      );
    }
  };
  return { ffmpegPath: 'ffmpeg', yapPath: 'yap', tmpDir: mkdtempSync(join(tmpdir(), 'cp')), run };
}

describe('composeDelivery', () => {
  it('builds a minimal input when there is nothing to say', async () => {
    const out = await composeDelivery({ ...base, strokes: [], segments: [], transcribe: fakeTranscribe('x') });
    expect(out).toEqual({ png, scene: { elements: [] }, boardName: 'main' });
  });

  it('writes a timeline for strokes alone', async () => {
    const out = await composeDelivery({
      ...base,
      strokes: [stroke(1000)],
      segments: [],
      notes: 'a note',
      mode: 'submit',
      sessionId: 's1',
      transcribe: fakeTranscribe('x'),
    });
    expect(out.timelineMd).toContain('stroke 1');
    expect(out).toMatchObject({ notes: 'a note', mode: 'submit', sessionId: 's1' });
    expect(out.transcript).toBeUndefined();
    expect(out.speech).toBeUndefined();
    expect(out.audio).toBeUndefined();
  });

  it('transcribes segments into transcript, speech, timeline and audio', async () => {
    const segment: VoiceSegment = {
      name: 'seg-0.webm',
      data: Buffer.from('AUDIO'),
      startMs: 2000,
      mimeType: 'audio/webm;codecs=opus',
    };
    const out = await composeDelivery({
      ...base,
      strokes: [stroke(3000)],
      segments: [segment],
      transcribe: fakeTranscribe('this is the header'),
    });
    expect(out.speech).toBe('this is the header');
    expect(out.transcript).toEqual([
      { t: 3000, tEnd: 4000, text: 'this is the header', audio: 'audio/seg-0.webm', audioStart: 2000 },
    ]);
    expect(out.timelineMd).toContain('"this is the header"');
    expect(out.audio).toEqual([{ name: 'seg-0.webm', data: segment.data }]);
  });

  it('keeps the audio when transcription fails', async () => {
    const errors: string[] = [];
    const out = await composeDelivery({
      ...base,
      strokes: [],
      segments: [{ name: 'a.webm', data: Buffer.from('A'), startMs: 0, mimeType: 'audio/webm' }],
      transcribe: {
        ffmpegPath: 'ffmpeg',
        yapPath: 'yap',
        tmpDir: mkdtempSync(join(tmpdir(), 'cp')),
        run: async () => {
          throw new Error('nope');
        },
        onError: (name) => errors.push(name),
      },
    });
    expect(errors).toEqual(['a.webm']);
    expect(out.audio).toHaveLength(1);
    expect(out.timelineMd).toBeUndefined();
    expect(out.speech).toBeUndefined();
  });
});

describe('findTool', () => {
  it('returns the first executable file among the given dirs', () => {
    const a = mkdtempSync(join(tmpdir(), 'ft'));
    const b = mkdtempSync(join(tmpdir(), 'ft'));
    writeFileSync(join(a, 'plain'), '');
    chmodSync(join(a, 'plain'), 0o644);
    writeFileSync(join(b, 'plain'), '');
    chmodSync(join(b, 'plain'), 0o755);
    mkdirSync(join(a, 'adir'));
    expect(findTool('plain', ['', join(tmpdir(), 'nonexistent'), a, b])).toBe(join(b, 'plain'));
    expect(findTool('adir', [a])).toBeUndefined();
    expect(findTool('missing-tool-xyz', [a, b])).toBeUndefined();
  });

  it('searches PATH by default', () => {
    expect(findTool('node')).toBeTruthy();
  });
});

const FFMPEG = findTool('ffmpeg');
const YAP = findTool('yap');
const FIXTURE = fileURLToPath(new URL('../../e2e/fixtures/speech.wav', import.meta.url));

const servers: { close(): Promise<void> }[] = [];
afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
});

describe.skipIf(!FFMPEG || !YAP || !existsSync(FIXTURE))('compose then deliver', () => {
  it('writes the bundle and a draft with the image, speech and timeline', async () => {
    const work = mkdtempSync(join(tmpdir(), 'e2e'));
    const webm = join(work, 'speech.webm');
    execFileSync(FFMPEG!, ['-y', '-loglevel', 'error', '-i', FIXTURE, '-c:a', 'libopus', webm]);

    const input = await composeDelivery({
      ...base,
      png: Buffer.from('PNGDATA'),
      scene: { type: 'excalidraw', elements: [{ id: 'e1' }] },
      notes: 'make the header sticky',
      strokes: [
        stroke(500),
        stroke(900, { bbox: { x: 40, y: 20, width: 50, height: 50 } }),
        stroke(6000, { by: 'claude', type: 'rectangle', elementId: 'r1', label: 'Header' }),
      ],
      segments: [
        { name: 'seg-0.webm', data: await readFile(webm), startMs: 0, mimeType: 'audio/webm;codecs=opus' },
      ],
      transcribe: { ffmpegPath: FFMPEG!, yapPath: YAP!, tmpDir: join(work, 'tmp') },
    });
    expect(input.speech).toBeTruthy();

    const dir = mkdtempSync(join(tmpdir(), 'sock'));
    const socketPath = join(dir, 's.sock');
    const server = createCompanionServer({ socketPath, backend: fakeBackend() });
    servers.push(server);
    await server.listen();
    const project = mkdtempSync(join(tmpdir(), 'proj'));
    await request(socketPath, 'POST', '/sessions', { sessionId: 's1', cwd: project });
    server.setTarget('s1');

    const d = await server.deliver(input);
    const read = (f: string) => readFileSync(join(d.dir, f));
    expect(read('sketch.png').toString()).toBe('PNGDATA');
    expect(JSON.parse(read('board.excalidraw').toString()).elements).toEqual([{ id: 'e1' }]);
    expect(read('notes.md').toString()).toBe('make the header sticky');
    expect(read('timeline.md').toString()).toContain('strokes 1–2');
    expect(read('timeline.md').toString()).toContain('Claude drew r1 rectangle "Header"');
    expect(JSON.parse(read('transcript.json').toString())[0]).toMatchObject({ audio: 'audio/seg-0.webm' });
    expect(existsSync(join(d.dir, 'audio', 'seg-0.webm'))).toBe(true);

    expect(d.draft).toContain(`@.feedback/sketches/${d.id}/sketch.png`);
    expect(d.draft).toContain(`Said while drawing: "${input.speech}"`);
    expect(d.draft).toContain('Notes: make the header sticky');
    expect(d.draft).toContain(`Timeline: .feedback/sketches/${d.id}/timeline.md`);
  }, 120_000);
});
