import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Dictator, type DictationPhrase } from './dictate';

const FAKE = join(__dirname, '../../e2e/fixtures/fake-dictate.mjs');

let dictators: Dictator[] = [];
afterEach(() => {
  for (const d of dictators) d.dispose();
  dictators = [];
});

/** A dictator on the fake helper, scripted by `script`. */
function dictator(script: object, argv: readonly string[] = [process.execPath, FAKE]) {
  const log: string[] = [];
  const launches: number[] = [];
  const d = new Dictator({
    argv: () => {
      launches.push(1);
      return argv;
    },
    log: (line) => log.push(line),
  });
  dictators.push(d);
  process.env.FAKE_DICTATE = JSON.stringify(script);
  return { d, log, launches };
}

async function start(d: Dictator) {
  const phrases: DictationPhrase[] = [];
  const live: DictationPhrase[] = [];
  let ended: { error?: string } | undefined;
  let ready = 0;
  const dictation = await d.start({
    onReady: () => ready++,
    onLive: (p) => live.push(p),
    onPhrase: (p) => phrases.push(p),
    onEnd: (error) => (ended = { ...(error ? { error } : {}) }),
  });
  return { dictation: dictation!, phrases, live, ended: () => ended, ready: () => ready };
}

describe('Dictator', () => {
  afterEach(() => delete process.env.FAKE_DICTATE);

  it('passes each phrase on as the helper prints it, and the one in progress on stop', async () => {
    const { d } = dictator({ phrases: [{ at: 50, start: 0.4, text: ' One. ' }], last: 'Two.' });
    const { dictation, phrases, ended, ready } = await start(d);
    await expect.poll(() => phrases.length).toBe(1);
    expect(ready()).toBe(1);
    expect(phrases[0]!.text).toBe('One.');
    expect(ended()).toBeUndefined();
    await dictation.stop();
    expect(phrases.map((p) => p.text)).toEqual(['One.', 'Two.']);
    expect(ended()).toEqual({});
  });

  it('passes words still settling, with their times', async () => {
    const { d } = dictator({ live: [{ at: 30, start: 0.2, text: 'Bigger head', words: [[0.2, 'Bigger'], [0.6, 'head']] }] });
    const { dictation, live } = await start(d);
    await expect.poll(() => live.length).toBe(1);
    const [bigger, head] = live[0]!.words!;
    expect(live[0]!.text).toBe('Bigger head');
    expect(head!.atMs - bigger!.atMs).toBe(400);
    await dictation.stop();
  });

  it('dictates on a loaded spare and loads the next one after', async () => {
    const { d, log, launches } = dictator({ last: 'Done.' });
    await d.warm();
    await d.warm();
    expect(launches).toHaveLength(1);
    const { dictation, ready } = await start(d);
    expect(launches).toHaveLength(1);
    await expect.poll(() => ready()).toBe(1);
    expect(log[0]).toMatch(/^mic on in \d+ ms \(spare\)$/);
    await dictation.stop();
    await expect.poll(() => launches.length).toBe(2);
  });

  it('reports why the helper failed', async () => {
    const { d } = dictator({}, ['sh', '-c', 'echo \'{"error":"Could not open the microphone."}\'; exit 1']);
    const { ended } = await start(d);
    await expect.poll(() => ended()).toBeDefined();
    expect(ended()).toEqual({ error: 'Could not open the microphone.' });
  });

  it('reports a helper that cannot start', async () => {
    const { d } = dictator({}, ['/nonexistent/agent-brief-dictate']);
    const { dictation, ended } = await start(d);
    await dictation.stop();
    await expect.poll(() => ended()).toBeDefined();
    expect(ended()?.error).toMatch(/^Dictation failed: .*ENOENT/);
  });

  it('is unavailable without a helper', async () => {
    const d = new Dictator({ argv: () => undefined });
    expect(await d.start({ onPhrase: () => {}, onEnd: () => {} })).toBeUndefined();
  });
});
