import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { main } from '../../cli/main';
import { FeedbackStore } from '../main/feedback';
import { FeedbackSnaps } from '../main/feedback-snap';
import { SOCKET_ENV } from '../protocol';
import { createCompanionServer } from './index';
import { closeServers, openServers } from './server-testkit';
import { fakeBackend, request, tempDir } from './testkit';

afterEach(closeServers);

async function setup() {
  const root = tempDir();
  const socketPath = join(root, 's.sock');
  const feedback = new FeedbackStore(undefined, () => new Date(2026, 9, 18));
  const feedbackSnaps = new FeedbackSnaps({ store: feedback, urlFor: (_r, p) => `review://${p}`, capture: async () => ({ png: Buffer.from('png') }) });
  const server = createCompanionServer({ socketPath, backend: fakeBackend(), feedback, feedbackSnaps });
  openServers.push(server);
  await server.listen();
  mkdirSync(join(root, 'prototype'));
  writeFileSync(join(root, 'prototype/checkout.html'), '<div id="filters"></div>');
  writeFileSync(join(root, 'prototype/pricing.html'), '<h1>Pricing</h1>');
  writeFileSync(join(root, 'prd.md'), '# PRD');
  await request(socketPath, 'POST', '/sessions', { sessionId: 's1', cwd: root });
  const cli = async (...args: string[]) => {
    let out = '', err = '';
    const code = await main(['feedback', ...args], { env: { [SOCKET_ENV]: socketPath, CLAUDE_CODE_SESSION_ID: 's1' }, cwd: root, stdin: async () => '', stdout: (s) => { out += s; }, stderr: (s) => { err += s; } });
    return { code, out, err };
  };
  return { root, cli };
}

it('snaps before and after pictures through the CLI', async () => {
  const { root, cli } = await setup();
  await cli('round', 'prototype/checkout.html', '--label', 'customers');
  await cli('add', 'prototype/checkout.html', '--title', 'Hard to find the filters', '--where', '#filters');
  expect(await cli('snap', 'prototype/checkout.html', '1', '--before')).toMatchObject({ code: 0, out: 'saved prototype/checkout.html.feedback/1-r1-before.png on #1 [open] Hard to find the filters · round 1\n' });
  const after = JSON.parse((await cli('snap', 'prototype/checkout.html', '#1', '--after', '--round', '1', '--json')).out);
  expect(after).toMatchObject({ picture: 'prototype/checkout.html.feedback/1-r1-after.png', items: [{ before: ['checkout.html.feedback/1-r1-before.png'], after: ['checkout.html.feedback/1-r1-after.png'] }] });
  expect(existsSync(join(root, after.picture))).toBe(true);

  expect(await cli('snap', 'prototype/checkout.html', '1')).toMatchObject({ code: 2, err: expect.stringContaining('snap needs --before or --after') });
  expect(await cli('snap', 'prototype/checkout.html', '1', '--before', '--after')).toMatchObject({ code: 2 });
  await cli('round', 'prd.md', '--label', 'SME');
  await cli('add', 'prd.md', '--title', 'Thin');
  expect(await cli('snap', 'prd.md', '1', '--before')).toMatchObject({ code: 1, err: expect.stringContaining('Snapshots need an HTML output') });
});

it('prints the project graph as text and JSON', async () => {
  const { cli } = await setup();
  await cli('round', 'prototype/pricing.html', '--label', 'SME', '--source', 'transcripts/sme-2.md');
  await cli('add', 'prototype/pricing.html', '--title', 'Plans hide the filters');
  await cli('round', 'prototype/checkout.html', '--label', 'SME', '--source', 'transcripts/sme-2.md');
  await cli('add', 'prototype/checkout.html', '--title', 'Hard to find the filters', '--related', 'pricing.html #1');
  await cli('log', 'prototype/checkout.html', '1', 'Workspace', 'saved · fb-checkout-1 · checkout.html.feedback/1-workspace.png');
  expect((await cli('graph')).out).toBe(`1 source · 2 items · 2 outputs · 1 workspace

prototype/checkout.html
  #1 [open] Hard to find the filters
    raised by SME · sme-2.md
    related → prototype/pricing.html #1
    worked in fb-checkout-1

prototype/pricing.html
  #1 [open] Plans hide the filters
    raised by SME · sme-2.md
    related ← prototype/checkout.html #1
`);
  const graph = JSON.parse((await cli('graph', '--json')).out);
  expect(graph.edges).toContainEqual({ from: 'item:prototype/checkout.html#1', to: 'item:prototype/pricing.html#1', kind: 'related' });
  expect(graph.nodes.filter((n: { kind: string }) => n.kind === 'source')).toHaveLength(1);
});
