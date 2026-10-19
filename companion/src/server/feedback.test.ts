import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
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
  const cli = async (args: string[], session = 's1', stdin = '') => {
    let out = '', err = '';
    const code = await main(['feedback', ...args], { env: { [SOCKET_ENV]: socketPath, CLAUDE_CODE_SESSION_ID: session }, cwd: root, stdin: async () => stdin, stdout: (s) => { out += s; }, stderr: (s) => { err += s; } });
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

it('shows and relates a feedback file whose output was deleted, and refuses writes to it', async () => {
  const { root, cli } = await setup();
  await cli(['round', 'prototype/pricing.html', '--label', 'SME']);
  await cli(['add', 'prototype/pricing.html', '--title', 'Plan cards hide the filter chips']);
  await cli(['round', 'prototype/checkout.html', '--label', 'SME']);
  await cli(['add', 'prototype/checkout.html', '--title', 'Filter chips are hidden', '--related', 'pricing.html #1']);
  unlinkSync(join(root, 'prototype/checkout.html'));
  const shown = await cli(['show', 'prototype/checkout.html']);
  expect(shown).toMatchObject({ code: 0 });
  expect(shown.out).toContain('#1 [open] Filter chips are hidden');
  expect(JSON.parse((await cli(['show', 'prototype/checkout.html', '--json'])).out)).toMatchObject({ output: 'prototype/checkout.html', outputExists: false });
  expect((await cli(['related', 'prototype/checkout.html', '1'])).out).toContain('→ prototype/pricing.html #1 [open] Plan cards hide the filter chips');
  expect((await cli(['related', 'prototype/pricing.html', '1'])).out).toContain('← prototype/checkout.html #1 [open] Filter chips are hidden');
  const write = await cli(['log', 'prototype/checkout.html', '1', 'Claude', 'note · x']);
  expect(write.code).not.toBe(0);
  expect(write.err).toContain('Output must be a file');
});

it('says when a round is already there, and takes the transcript date', async () => {
  const { root, cli } = await setup();
  const args = ['round', 'prototype/checkout.html', '--label', 'customers', '--source', 'transcripts/cust-1.md'];
  expect((await cli([...args, '--date', '2026-10-12'])).out).toBe('added round 1 · customers · 2026-10-12 · transcripts/cust-1.md to prototype/checkout.html.feedback.md\n');
  const before = readFileSync(join(root, 'prototype/checkout.html.feedback.md'), 'utf8');
  expect((await cli(args)).out).toBe('round 1 already exists in prototype/checkout.html.feedback.md · customers · 2026-10-12 · transcripts/cust-1.md\n');
  expect(readFileSync(join(root, 'prototype/checkout.html.feedback.md'), 'utf8')).toBe(before);
  expect((await cli(['round', 'prototype/pricing.html', '--label', 'customers', '--source', 'transcripts/cust-1.md'])).out).toContain('added round 1 ·');
  expect((await cli(['round', 'prototype/pricing.html', '--label', 'SME', '--date', 'Oct 12'])).code).toBe(1);
});

it('revises a change, adds options and checks several points at once', async () => {
  const { root, cli } = await setup();
  await cli(['round', 'prototype/checkout.html', '--label', 'customers']);
  await cli(['add', 'prototype/checkout.html', '--title', 'Empty saved box is confusing', '--src', '1 · Ben · 05:40 · "It says "Nothing yet" and then what?"', '--option', 'A · Explain how to save', '--option', 'B · Hide the box until something is saved']);
  await cli(['add', 'prototype/checkout.html', '--title', 'Filter chips are hidden']);
  expect((await cli(['change', 'prototype/checkout.html', '1', 'Hide the box, and explain saving on the cart'])).out).toBe('changed #1 [open] Empty saved box is confusing · round 1: Hide the box, and explain saving on the cart\n');
  const text = readFileSync(join(root, 'prototype/checkout.html.feedback.md'), 'utf8');
  expect(text).toContain('    Src: 1 · Ben · 05:40 · "It says "Nothing yet" and then what?"\n    Option: A · Explain how to save\n    Option: B · Hide the box until something is saved\n');
  expect(JSON.parse((await cli(['show', 'prototype/checkout.html', '--json'])).out).items[0]).toMatchObject({ change: 'Hide the box, and explain saving on the cart', options: [{ key: 'A' }, { key: 'B' }] });
  const both = await cli(['related', 'prototype/checkout.html', '--text', 'the saved box confuses people', '--text', 'cannot see the filter chips']);
  expect(both.out).toBe([
    '"the saved box confuses people"',
    '  prototype/checkout.html #1 [open] Empty saved box is confusing · round 1 · shares saved, box',
    '"cannot see the filter chips"',
    '  prototype/checkout.html #2 [open] Filter chips are hidden · round 1 · shares filter, chip',
    '',
  ].join('\n'));
});

it('catalogs a round in one call, joining repeats and naming look-alikes', async () => {
  const { root, cli } = await setup();
  await cli(['round', 'prototype/pricing.html', '--label', 'SME', '--source', 'transcripts/sme-1.md']);
  await cli(['add', 'prototype/pricing.html', '--title', 'Fees show up too late']);
  await cli(['round', 'prototype/checkout.html', '--label', 'customers', '--source', 'transcripts/cust-1.md']);
  await cli(['add', 'prototype/checkout.html', '--title', 'Hard to find the filters', '--src', '2 · Ana · 03:02 · "Where do I filter?"']);
  const items = JSON.stringify([
    { title: 'Surprise fees at checkout', src: ['Dev · 04:10 · "Fees only show up after you press the button"'], change: 'Show fees in the cart', where: '#fees', options: ['A · Fees in the cart', 'B · Fees on the button'] },
    { same: 1, src: 'Maya · 00:14 · "I couldn\'t find the filters"', change: 'Move the filters above the grid' },
    { title: 'Sign-in is forced', src: ['Dev · 11:20 · "Forcing sign-in will cost conversions"'], related: ['pricing.html #1'] },
  ]);
  const args = ['catalog', 'prototype/checkout.html', '--label', 'SME', '--source', 'transcripts/sme-1.md', '--date', '2026-10-17', '--items', '-'];
  const first = await cli(args, 's1', items);
  expect(first).toMatchObject({ code: 0, err: '' });
  expect(first.out).toBe([
    'added round 1 · SME · 2026-10-17 · transcripts/sme-1.md to prototype/checkout.html.feedback.md',
    'added #2 [open] Surprise fees at checkout · round 1',
    '  looks like prototype/pricing.html #1 [open] Fees show up too late · round 1 · shares fee, show',
    'joined #1 [open] Hard to find the filters · round 1, also 2',
    'added #3 [open] Sign-in is forced · round 1',
    '',
  ].join('\n'));
  const doc = JSON.parse((await cli(['show', 'prototype/checkout.html', '--json'])).out);
  expect(doc.rounds.map((r: { n: number }) => r.n)).toEqual([2, 1]);
  expect(doc.items[0]).toMatchObject({ change: 'Move the filters above the grid', rounds: [1, 2] });
  expect(doc.items[1]).toMatchObject({ round: 1, where: '#fees', options: [{ key: 'A' }, { key: 'B' }], sources: [{ round: 1, speaker: 'Dev', quote: 'Fees only show up after you press the button' }] });
  expect(doc.items[2]).toMatchObject({ related: [{ path: 'pricing.html', n: 1 }] });
  // Running it again writes nothing.
  const before = readFileSync(join(root, 'prototype/checkout.html.feedback.md'), 'utf8');
  const again = await cli(args, 's1', items);
  expect(again.out).toBe([
    'round 1 already exists in prototype/checkout.html.feedback.md · SME · 2026-10-17 · transcripts/sme-1.md',
    'skipped "Surprise fees at checkout": #2 has it',
    'skipped #1: it has these quotes',
    'skipped "Sign-in is forced": #3 has it',
    '',
  ].join('\n'));
  expect(readFileSync(join(root, 'prototype/checkout.html.feedback.md'), 'utf8')).toBe(before);
  expect((await cli(args, 's1', '[{"src": "x"}]')).err).toContain('item 1 needs a title, or "same"');
});
