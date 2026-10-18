import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { main } from '../../cli/main';
import { BehaviorStore } from '../main/behavior';
import { SOCKET_ENV } from '../protocol';
import { createCompanionServer } from './index';
import { closeServers, openServers } from './server-testkit';
import { fakeBackend, request, tempDir } from './testkit';
import { reviewMarkdown } from '../shared/review';

afterEach(closeServers);

it('supports the CLI create/read/update/export loop across sessions and returns conflicts', async () => {
  const root = tempDir();
  const socketPath = join(root, 's.sock');
  const behaviors = new BehaviorStore();
  const server = createCompanionServer({ socketPath, backend: fakeBackend(), behaviors });
  openServers.push(server);
  await server.listen();
  writeFileSync(join(root, 'mock.html'), '<button>Skip</button>');
  for (const sessionId of ['s1', 's2']) await request(socketPath, 'POST', '/sessions', { sessionId, cwd: root });
  const cli = async (args: string[], patch = '', session = 's1') => {
    let out = '', err = '';
    const code = await main(['behavior', ...args], { env: { [SOCKET_ENV]: socketPath, CLAUDE_CODE_SESSION_ID: session }, cwd: root, stdin: async () => patch, stdout: (s) => { out += s; }, stderr: (s) => { err += s; } });
    return { code, out, err };
  };
  const empty = JSON.parse((await cli(['show', 'mock.html', '--json'])).out);
  expect(empty.version).toBe('missing');
  const patch = { version: empty.version, upsert: [{ id: 'skip', text: 'Skip advances without sending invitations.', status: 'confirmed', source: { kind: 'brief', ref: 'brief.md: Invitations are optional' }, delivery: 'planned' }], limitations: ['Invitations are simulated'] };
  const added = await cli(['update', 'mock.html', '--json'], JSON.stringify(patch));
  expect(added.code).toBe(0);
  const doc = JSON.parse(added.out);
  expect(JSON.parse((await cli(['show', 'mock.html', '--json'], '', 's2')).out)).toEqual(doc);
  expect((await cli(['update', 'mock.html'], JSON.stringify(patch))).err).toContain('conflict');
  const exported = await cli(['export', 'mock.html', '--out', 'acceptance.md']);
  expect(exported.code).toBe(0);
  expect(readFileSync(join(root, 'acceptance.md'), 'utf8')).toContain('[skip] Skip advances');
  const md = reviewMarkdown({ path: 'mock.html', comments: [], behavior: doc }, () => undefined);
  expect(md).toContain('Confirmed acceptance criteria');
  expect(md).toContain('Invitations are simulated');
  expect((await request(socketPath, 'GET', '/sessions/missing/behavior?path=mock.html')).status).toBe(404);
  expect((await request(socketPath, 'GET', '/sessions/s1/behavior?path=../outside.html')).status).toBe(400);
});
