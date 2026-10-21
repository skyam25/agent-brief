import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SegmentReader, startDictation, type DictationPhrase } from './dictate';

const FAKE = join(__dirname, '../../e2e/fixtures/fake-dictate.mjs');

/** yap's streaming output for two phrases, as it prints them. */
const STREAM =
  '{\n  "metadata" : {\n    "created" : "2026-10-21T09:01:08Z",\n    "language" : "en-US"\n  },\n  "segments" : [' +
  '\n    {\n      "end" : 4.98,\n      "id" : 1,\n      "start" : 2.52,\n      "text" : "Rename the {pricing} heading."\n    }' +
  ',\n    {\n      "end" : 7.1,\n      "id" : 2,\n      "start" : 5.04,\n      "text" : "Say \\"plans\\" instead."\n    }' +
  '\n  ]\n}\n';

describe('SegmentReader', () => {
  it('hands over each segment once it closes, however the output is split', () => {
    for (const size of [1, 7, 64, STREAM.length]) {
      const reader = new SegmentReader();
      const found = [];
      for (let i = 0; i < STREAM.length; i += size) found.push(...reader.push(STREAM.slice(i, i + size)));
      expect(found).toEqual([
        { start: 2.52, text: 'Rename the {pricing} heading.' },
        { start: 5.04, text: 'Say "plans" instead.' },
      ]);
    }
  });

  it('waits for a segment that has not closed yet', () => {
    const reader = new SegmentReader();
    const cut = STREAM.indexOf('"id" : 2');
    expect(reader.push(STREAM.slice(0, cut))).toHaveLength(1);
    expect(reader.push(STREAM.slice(cut))).toEqual([{ start: 5.04, text: 'Say "plans" instead.' }]);
  });
});

/** Starts dictation with the fake yap, scripted by `script`. */
function run(script: object, argv: readonly string[] = [process.execPath, FAKE]) {
  const phrases: DictationPhrase[] = [];
  let ended: { error?: string } | undefined;
  process.env.FAKE_DICTATE = JSON.stringify(script);
  const dictation = startDictation({
    argv,
    now: () => 1_000_000,
    onPhrase: (p) => phrases.push(p),
    onEnd: (error) => (ended = { ...(error ? { error } : {}) }),
  });
  delete process.env.FAKE_DICTATE;
  return { dictation, phrases, ended: () => ended };
}

describe('startDictation', () => {
  it('passes each phrase on as yap prints it, and the one in progress on stop', async () => {
    const { dictation, phrases, ended } = run({ phrases: [{ at: 50, start: 0.4, text: ' One. ' }], last: 'Two.' });
    await expect.poll(() => phrases.length).toBe(1);
    expect(phrases[0]).toEqual({ text: 'One.', atMs: 1_000_400 });
    expect(ended()).toBeUndefined();
    await dictation.stop();
    expect(phrases.map((p) => p.text)).toEqual(['One.', 'Two.']);
    expect(ended()).toEqual({});
  });

  it('reports why yap failed', async () => {
    const { ended } = run({}, ['sh', '-c', 'echo "Error: Microphone permission is required." >&2; exit 1']);
    await expect.poll(() => ended()).toBeDefined();
    expect(ended()).toEqual({ error: 'Dictation failed: Microphone permission is required.' });
  });

  it('reports a yap that cannot start', async () => {
    const { dictation, ended } = run({}, ['/nonexistent/yap']);
    await dictation.stop();
    expect(ended()?.error).toMatch(/^Dictation failed: .*ENOENT/);
  });
});
