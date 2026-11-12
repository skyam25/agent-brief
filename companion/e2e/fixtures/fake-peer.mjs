#!/usr/bin/env node
/**
 * Stands in for the `agent-brief-peer` helper in tests. It prints `ready` and runs until its stdin closes or SIGTERM.
 * FAKE_PEER `fail` prints `failed: <fail>` and exits 1. `crashAfter` exits 1 that many ms after `ready`.
 * `silent` never prints `ready`. Each launch appends `{ "args": [...], "pid": n }` to the file FAKE_PEER_LOG names.
 *
 *   FAKE_PEER='{"crashAfter":50}'
 */

import { appendFileSync } from 'node:fs';

const { fail, crashAfter, silent } = JSON.parse(process.env.FAKE_PEER ?? '{}');
const log = (o) => process.env.FAKE_PEER_LOG && appendFileSync(process.env.FAKE_PEER_LOG, `${JSON.stringify(o)}\n`);

log({ args: process.argv.slice(2), pid: process.pid });
if (fail) {
  process.stdout.write(`failed: ${fail}\n`);
  process.exit(1);
}
if (!silent) process.stdout.write('ready\n');
if (crashAfter !== undefined) setTimeout(() => process.exit(1), crashAfter);
process.stdin.resume();
process.stdin.on('end', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
