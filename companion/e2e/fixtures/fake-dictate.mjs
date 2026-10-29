#!/usr/bin/env node
/**
 * Stands in for `yap dictate --json` in tests. It prints yap's streaming JSON, one phrase per
 * entry in FAKE_DICTATE `phrases`, each `at` ms after launch. SIGINT prints `last` and exits.
 * A phrase's optional `words` are yap's word times, as `[start, text]` pairs in seconds.
 * With `ready`, it says its microphone runs `ready` ms after launch, as yap does in a terminal, and prints its header then.
 *
 *   FAKE_DICTATE='{"phrases":[{"at":400,"text":"One."}],"last":"Two."}'
 */

const { phrases = [], last, ready } = JSON.parse(process.env.FAKE_DICTATE ?? '{}');
const launched = Date.now();
let id = 0;

const segment = (start, text, words) => {
  const timed = words ? { words: words.map(([s, t]) => ({ end: s + 0.2, start: s, text: t })) } : {};
  const body = JSON.stringify({ end: start + 1, id: ++id, start, text, ...timed }, null, 2).replace(/^/gm, '    ');
  process.stdout.write(`${id > 1 ? ',\n' : ''}${body}`);
};

const header = () => process.stdout.write(`{\n  "metadata" : {\n    "language" : "en-US"\n  },\n  "segments" : [`);
if (ready === undefined) header();
else setTimeout(() => (process.stdout.write('Dictating… Press Ctrl+C to stop.\r\n'), header()), ready);
for (const p of phrases) setTimeout(() => segment(p.start ?? Math.max(0, p.at - 1000) / 1000, p.text, p.words), p.at);
process.on('SIGINT', () => {
  if (last) segment((Date.now() - launched) / 1000, last);
  process.stdout.write(`${id > 0 ? '\n' : ''}  ]\n}\n`);
  process.exit(0);
});
setInterval(() => {}, 60_000);
