import { existsSync } from 'node:fs';
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

/** Starts dictation with the fake yap, scripted by `script`. The clock reads 1,000,000 at launch and 2,000,000 after. */
function run(script: object, argv: readonly string[] = [process.execPath, FAKE]) {
  const phrases: DictationPhrase[] = [];
  let ended: { error?: string } | undefined;
  let ready = 0;
  let reads = 0;
  process.env.FAKE_DICTATE = JSON.stringify(script);
  const dictation = startDictation({
    argv,
    now: () => (reads++ === 0 ? 1_000_000 : 2_000_000),
    onReady: () => ready++,
    onPhrase: (p) => phrases.push(p),
    onEnd: (error) => (ended = { ...(error ? { error } : {}) }),
  });
  delete process.env.FAKE_DICTATE;
  return { dictation, phrases, ended: () => ended, ready: () => ready };
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

  it('passes word times on, with the punctuation from the phrase text', async () => {
    const words = [[0.4, 'Bigger'], [0.9, 'header'], [1.5, 'and'], [1.7, 'a'], [1.9, 'darker'], [2.3, 'button']];
    const { dictation, phrases } = run({ phrases: [{ at: 50, start: 0.4, text: 'Bigger header, and a darker button.', words }] });
    await expect.poll(() => phrases.length).toBe(1);
    expect(phrases[0]!.words).toEqual([
      { text: 'Bigger', atMs: 1_000_400 },
      { text: 'header,', atMs: 1_000_900 },
      { text: 'and', atMs: 1_001_500 },
      { text: 'a', atMs: 1_001_700 },
      { text: 'darker', atMs: 1_001_900 },
      { text: 'button.', atMs: 1_002_300 },
    ]);
    await dictation.stop();
  });

  it('keeps yap\'s word texts when the phrase text does not line up with them', async () => {
    const { dictation, phrases } = run({ phrases: [{ at: 50, start: 0, text: 'Pay $5 now.', words: [[0, 'Pay'], [0.3, 'five'], [0.6, 'dollars'], [0.9, 'now']] }] });
    await expect.poll(() => phrases.length).toBe(1);
    expect(phrases[0]!.words!.map((w) => w.text)).toEqual(['Pay', 'five', 'dollars', 'now']);
    await dictation.stop();
  });

  it('starts the clock when yap says its microphone runs, so a slow start shifts no word', async () => {
    const words = [[0.4, 'Bigger'], [0.9, 'header']];
    const { dictation, phrases, ready } = run({ ready: 30, phrases: [{ at: 80, start: 0.4, text: 'Bigger header.', words }] });
    await expect.poll(() => phrases.length).toBe(1);
    expect(ready()).toBe(1);
    expect(phrases[0]).toMatchObject({ atMs: 2_000_400, words: [{ text: 'Bigger', atMs: 2_000_400 }, { text: 'header.', atMs: 2_000_900 }] });
    await dictation.stop();
  });

  it('is ready once the output starts, keeping the launch clock, when yap never says so', async () => {
    const { dictation, phrases, ready } = run({ phrases: [{ at: 50, start: 0.4, text: 'One.' }] });
    await expect.poll(() => phrases.length).toBe(1);
    expect(ready()).toBe(1);
    expect(phrases[0]!.atMs).toBe(1_000_400);
    await dictation.stop();
  });

  it.runIf(existsSync('/usr/bin/script'))('stops yap under script so it still prints the phrase in progress', async () => {
    const { dictation, phrases, ended, ready } = run({ ready: 30, last: 'Two.' }, ['/usr/bin/script', '-q', '/dev/null', process.execPath, FAKE]);
    await expect.poll(() => ready()).toBe(1);
    await dictation.stop();
    expect(phrases.map((p) => p.text)).toEqual(['Two.']);
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
