import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { main } from '../../cli/main';
import { FeedbackStore } from '../main/feedback';
import { FeedbackWorkspaces } from '../main/feedback-workspace';
import { BoardStore } from '../main/store';
import { SOCKET_ENV } from '../protocol';
import { createCompanionServer } from './index';
import { closeServers, openServers } from './server-testkit';
import { fakeBackend, request, tempDir } from './testkit';

afterEach(closeServers);

it('prints the item workspace board through the CLI and adds a frame once per round', async () => {
  const root = tempDir();
  const socketPath = join(root, 's.sock');
  const backend = fakeBackend();
  const feedback = new FeedbackStore();
  const workspaces = new FeedbackWorkspaces({ feedback, store: new BoardStore(tempDir()), boards: backend });
  const server = createCompanionServer({ socketPath, backend, feedback, workspaces });
  openServers.push(server);
  await server.listen();
  mkdirSync(join(root, 'prototype'));
  writeFileSync(join(root, 'prototype/checkout.html'), '<div id="filters"></div>');
  await request(socketPath, 'POST', '/sessions', { sessionId: 's1', cwd: root });
  const cli = async (args: string[]) => {
    let out = '', err = '';
    const code = await main(['feedback', ...args], { env: { [SOCKET_ENV]: socketPath, CLAUDE_CODE_SESSION_ID: 's1' }, cwd: root, stdin: async () => '', stdout: (s) => { out += s; }, stderr: (s) => { err += s; } });
    return { code, out, err };
  };
  await cli(['round', 'prototype/checkout.html', '--label', 'customers']);
  await cli(['add', 'prototype/checkout.html', '--title', 'Hard to find the filters']);

  expect(await cli(['workspace', 'prototype/checkout.html', '#1'])).toMatchObject({
    code: 0,
    out: 'fb-checkout-1\nnew board with a Round 1 frame. Draw with: agent-brief draw --board fb-checkout-1\n',
  });
  expect(backend.draw).toHaveBeenCalledWith('fb-checkout-1', expect.objectContaining({ elements: expect.arrayContaining([expect.objectContaining({ type: 'frame', label: 'Round 1' })]) }));
  const again = JSON.parse((await cli(['workspace', 'prototype/checkout.html', '1', '--json'])).out);
  // The fake board reads back empty, so every open frames it again.
  expect(again).toMatchObject({ board: 'fb-checkout-1', round: 1, created: false });

  expect(await cli(['workspace', 'prototype/checkout.html', '9'])).toMatchObject({ code: 1, err: expect.stringContaining('no item #9') });
  expect(await cli(['workspace', 'prototype/checkout.html'])).toMatchObject({ code: 2, err: expect.stringContaining('workspace needs an item number') });
});
