#!/usr/bin/env node
/**
 * Stands in for the `agent-brief-dictate` helper in tests. It prints `prepared` at launch and waits for `start`.
 * The microphone runs `ready` ms after `start` (0 by default). Each entry in FAKE_DICTATE `phrases` prints
 * `at` ms after `start`, and each in `live` prints as words still settling. `start` and word times count
 * seconds from when the microphone runs, as `[start, text]` pairs. `stop` prints `last` and exits.
 *
 *   FAKE_DICTATE='{"phrases":[{"at":400,"text":"One."}],"last":"Two."}'
 */

import { createInterface } from 'node:readline';

const { phrases = [], live = [], last, ready = 0 } = JSON.parse(process.env.FAKE_DICTATE ?? '{}');
const say = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
let micAt;

const phrase = (start, text, words) => ({
  text,
  atMs: Math.round(micAt + start * 1000),
  ...(words ? { words: words.map(([s, t]) => ({ text: t, atMs: Math.round(micAt + s * 1000) })) } : {}),
});

say({ prepared: true });
const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  if (line === 'start') {
    const asked = Date.now();
    micAt = asked + ready;
    setTimeout(() => say({ ready: true, atMs: micAt }), ready);
    for (const p of live) setTimeout(() => say({ live: phrase(p.start ?? 0, p.text, p.words) }), p.at);
    for (const p of phrases) setTimeout(() => say({ phrase: phrase(p.start ?? Math.max(0, p.at - ready - 1000) / 1000, p.text, p.words) }), p.at);
  } else if (line === 'stop') {
    if (last && micAt !== undefined) say({ phrase: phrase((Date.now() - micAt) / 1000, last) });
    process.exit(0);
  }
});
lines.on('close', () => process.exit(0));
