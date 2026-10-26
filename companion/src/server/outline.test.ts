import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { OutlineStore } from '../main/outline';
import { createCompanionServer } from './index';
import { closeServers, openServers, start } from './server-testkit';
import { fakeBackend, request, tempDir } from './testkit';

afterEach(closeServers);

async function setup() {
  const root = tempDir();
  const socketPath = join(root, 's.sock');
  const server = createCompanionServer({ socketPath, backend: fakeBackend(), outlines: new OutlineStore(undefined, () => new Date(2026, 9, 25)) });
  openServers.push(server);
  await server.listen();
  await request(socketPath, 'POST', '/sessions', { sessionId: 's1', cwd: root });
  const call = (method: string, path: string, body?: unknown) => request(socketPath, method, path, body);
  return { root, call };
}

const url = '/sessions/s1/outline?path=docs/memo.outline.md';

it('creates, reads and lists an outline in the session project', async () => {
  const { call } = await setup();
  expect((await call('GET', url)).body).toMatchObject({ version: 'missing', path: 'docs/memo.outline.md' });
  const made = await call('POST', url, { version: 'missing', ops: [{ op: 'setMeta', title: 'Memo', target: 'docs/memo.md' }, { op: 'addSection', title: 'Why' }] });
  expect(made.status).toBe(200);
  expect(made.body).toMatchObject({ title: 'Memo', added: ['s1'], targetExists: false });
  expect((await call('GET', url)).body).toMatchObject({ title: 'Memo', version: made.body.version });
  expect((await call('GET', '/sessions/s1/outline/project')).body).toEqual({ files: [expect.objectContaining({ path: 'docs/memo.outline.md', sections: 1 })] });
});

it('answers 409 on a stale version and 400 on a bad op or path', async () => {
  const { call } = await setup();
  await call('POST', url, { version: 'missing', ops: [{ op: 'setMeta', title: 'Memo' }] });
  expect(await call('POST', url, { version: 'missing', ops: [{ op: 'addSection', title: 'A' }] })).toMatchObject({ status: 409, body: { code: 'conflict' } });
  const { version } = (await call('GET', url)).body;
  const badOp = await call('POST', url, { version, ops: [{ op: 'removePoint', id: 'p9' }] });
  expect(badOp).toMatchObject({ status: 400, body: { code: 'bad_request' } });
  expect(badOp.body.error).toContain('ops[0] removePoint');
  expect((await call('GET', '/sessions/s1/outline?path=../x.outline.md')).status).toBe(400);
  expect((await call('GET', '/sessions/s1/outline?path=docs/memo.md')).status).toBe(400);
});

it('answers 404 for an unknown session and 503 without a store', async () => {
  const { call } = await setup();
  expect((await call('GET', '/sessions/nope/outline?path=a.outline.md')).status).toBe(404);
  const h = await start();
  await h.call('POST', '/sessions', { sessionId: 'a', cwd: tempDir() });
  expect((await h.call('GET', '/sessions/a/outline/project')).status).toBe(503);
});
