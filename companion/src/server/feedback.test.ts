import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { main } from '../../cli/main';
import { FeedbackStore } from '../main/feedback';
import { SOCKET_ENV } from '../protocol';
import { createCompanionServer } from './index';
import { closeServers, openServers } from './server-testkit';
import { fakeBackend, request, tempDir } from './testkit';

afterEach(closeServers);

async function setup() {
  const root = tempDir();
  const socketPath = join(root, 's.sock');
  const server = createCompanionServer({ socketPath, backend: fakeBackend(), feedback: new FeedbackStore(undefined, () => new Date(2026, 9, 18)) });
  openServers.push(server);
  await server.listen();
  mkdirSync(join(root, 'prototype'));
  writeFileSync(join(root, 'prototype/checkout.html'), '<div id="filters"></div>');
  writeFileSync(join(root, 'prototype/pricing.html'), '<h1>Pricing</h1>');
  for (const sessionId of ['s1', 's2']) await request(socketPath, 'POST', '/sessions', { sessionId, cwd: root });
  const cli = async (args: string[], session = 's1') => {
    let out = '', err = '';
    const code = await main(['feedback', ...args], { env: { [SOCKET_ENV]: socketPath, CLAUDE_CODE_SESSION_ID: session }, cwd: root, stdin: async () => '', stdout: (s) => { out += s; }, stderr: (s) => { err += s; } });
    return { code, out, err };
  };
  return { root, socketPath, cli };
}

it('catalogs a round, logs and closes items through the CLI, across sessions', async () => {
  const { root, cli } = await setup();
  expect((await cli(['round', 'prototype/checkout.html', '--label', 'customers', '--source', 'transcripts/cust-1.md'])).out).toContain('added round 1');
  const added = await cli(['add', 'prototype/checkout.html', '--title', 'Hard to find the filters', '--src', '1 · Ana · 03:02 · "Where do I filter?"', '--src', '1 · Lee · 05:10 · "No filters?"', '--change', 'Move the filter row up', '--where', '#filters', '--related', 'pricing.html #1']);
  expect(added).toMatchObject({ code: 0, out: 'added #1 [open] Hard to find the filters · round 1 to prototype/checkout.html.feedback.md\n' });
  expect((await cli(['round', 'prototype/checkout.html', '--label', 'SME'])).out).toContain('added round 2');
  expect((await cli(['log', 'prototype/checkout.html', '1', 'Src', '2 · Maya · 00:14 · "I couldn\'t find the filters"'], 's2')).code).toBe(0);
  expect((await cli(['done', 'prototype/checkout.html', '#1', 'moved the row', '--commit', '3f2a91c'])).out).toBe('closed #1 [done] Hard to find the filters · round 1, also 2\n');
  const text = readFileSync(join(root, 'prototype/checkout.html.feedback.md'), 'utf8');
  expect(text).toBe(`# Feedback · checkout.html

## Round 2 · SME · 2026-10-18
## Round 1 · customers · 2026-10-18 · transcripts/cust-1.md

- [x] #1 Hard to find the filters
    Round: 1
    Src: 1 · Ana · 03:02 · "Where do I filter?"
    Src: 1 · Lee · 05:10 · "No filters?"
    Change: Move the filter row up
    Where: #filters
    Related: pricing.html #1
    Claude: 2026-10-18 · cataloged
    Src: 2 · Maya · 00:14 · "I couldn't find the filters"
    Claude: 2026-10-18 · done · moved the row · commit 3f2a91c
`);
  const shown = JSON.parse((await cli(['show', 'prototype/checkout.html', '--json'], 's2')).out);
  expect(shown.items[0]).toMatchObject({ state: 'done', rounds: [1, 2] });
  expect((await cli(['show', 'prototype/checkout.html'])).out).toContain('#1 [done] Hard to find the filters · round 1, also 2\n    Src: 1 · Ana');
});

it('lists project files and finds linked and look-alike items', async () => {
  const { cli } = await setup();
  await cli(['round', 'prototype/pricing.html', '--label', 'SME']);
  await cli(['add', 'prototype/pricing.html', '--title', 'Filter chips overlap the plans']);
  await cli(['round', 'prototype/checkout.html', '--label', 'customers']);
  await cli(['add', 'prototype/checkout.html', '--title', 'Filter chips are hidden', '--related', 'pricing.html #1']);
  await cli(['log', 'prototype/checkout.html', '1', 'Claude', 'note · checking mobile']);
  expect((await cli(['list'])).out).toBe('prototype/checkout.html · 1 open · 0 accepted · 0 rejected · 0 done · 1 round\nprototype/pricing.html · 1 open · 0 accepted · 0 rejected · 0 done · 1 round\n');
  const back = await cli(['related', 'prototype/pricing.html', '1']);
  expect(back.out).toContain('← prototype/checkout.html #1 [open] Filter chips are hidden');
  const view = JSON.parse((await cli(['related', 'prototype/checkout.html', '--text', 'the filter chips cover the plan cards', '--json'])).out);
  expect(view.similar.map((h: { output: string; item: { n: number } }) => `${h.output}#${h.item.n}`)).toEqual(['prototype/pricing.html#1', 'prototype/checkout.html#1']);
});

it('refuses You lines from the agent, stale versions, bad paths and unknown sessions', async () => {
  const { socketPath, cli } = await setup();
  await cli(['round', 'prototype/checkout.html', '--label', 'customers']);
  await cli(['add', 'prototype/checkout.html', '--title', 'A point']);
  const you = await cli(['log', 'prototype/checkout.html', '1', 'You', 'accept']);
  expect(you).toMatchObject({ code: 1 });
  expect(you.err).toContain('Only the user writes You lines');
  const route = '/sessions/s1/feedback?path=prototype/checkout.html';
  expect((await request(socketPath, 'POST', route, { version: 'stale', ops: [{ op: 'close', item: 1 }] })).status).toBe(409);
  expect((await request(socketPath, 'GET', '/sessions/s1/feedback?path=../outside.md')).status).toBe(400);
  expect((await request(socketPath, 'GET', '/sessions/missing/feedback?path=prototype/checkout.html')).status).toBe(404);
  expect((await cli(['add', 'prototype/checkout.html'])).code).toBe(2);
});
