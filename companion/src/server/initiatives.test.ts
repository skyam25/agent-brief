import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { InitiativeStore } from '../main/initiatives';
import { createCompanionServer } from './index';
import { fakeBackend, request, tempDir } from './testkit';
import { closeServers, openServers, start } from './server-testkit';

afterEach(closeServers);

async function startWithStore() {
  const dir = tempDir();
  const socketPath = join(dir, 's.sock');
  const store = new InitiativeStore(join(dir, 'data'), { home: dir });
  const server = createCompanionServer({ socketPath, backend: fakeBackend(), initiatives: store });
  openServers.push(server);
  await server.listen();
  const call = (method: string, path: string, body?: unknown) => request(socketPath, method, path, body);
  return { dir, store, call };
}

describe('initiative routes', () => {
  it('creates, lists, reads and updates an initiative', async () => {
    const h = await startWithStore();
    const created = await h.call('POST', '/initiatives', { title: 'Pricing', folder: join(h.dir, 'Pricing'), understanding: 'Monthly-first. Then legal.' });
    expect(created.status).toBe(200);
    const id = created.body.id;
    expect(created.body).toMatchObject({ title: 'Pricing', revision: 1, path: join(h.dir, 'Pricing', 'Pricing brief.md') });

    const list = await h.call('GET', '/initiatives');
    expect(list.body).toEqual([{ id, title: 'Pricing', lastActiveAt: created.body.lastActiveAt, line: 'Monthly-first.' }]);
    expect((await h.call('GET', `/initiatives/${id}`)).body).toMatchObject({ id, understanding: 'Monthly-first. Then legal.' });

    const put = await h.call('PUT', `/initiatives/${id}`, { revision: 1, decisions: ['2026-10-17 Monthly-first'], updatedBy: 'Claude · s1' });
    expect(put.body).toMatchObject({ revision: 2, decisions: ['2026-10-17 Monthly-first'], updatedBy: 'Claude · s1' });
    const history = await h.call('GET', `/initiatives/${id}/history`);
    expect(history.body.map((r: { revision: number }) => r.revision)).toEqual([2, 1]);
  });

  it('answers 409 to a stale revision', async () => {
    const h = await startWithStore();
    const { body } = await h.call('POST', '/initiatives', { title: 'Pricing', folder: h.dir });
    await h.call('PUT', `/initiatives/${body.id}`, { revision: 1, open: ['a'], updatedBy: 'PM' });
    const stale = await h.call('PUT', `/initiatives/${body.id}`, { revision: 1, open: ['b'], updatedBy: 'Claude · s1' });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('conflict');
  });

  it('answers 409 when the PM edited the file since the read', async () => {
    const h = await startWithStore();
    const { body } = await h.call('POST', '/initiatives', { title: 'Pricing', folder: h.dir });
    writeFileSync(body.path, readFileSync(body.path, 'utf8').replace('## Open\n', '## Open\n- By hand\n'));
    const stale = await h.call('PUT', `/initiatives/${body.id}`, { revision: 1, understanding: 'x', updatedBy: 'Claude · s1' });
    expect(stale.status).toBe(409);
    expect((await h.call('GET', `/initiatives/${body.id}`)).body).toMatchObject({ revision: 2, updatedBy: 'PM' });
  });

  it('orders recent by lastActiveAt and limits it', async () => {
    const h = await startWithStore();
    const a = (await h.call('POST', '/initiatives', { title: 'Pricing', folder: join(h.dir, 'a') })).body;
    await h.call('POST', '/initiatives', { title: 'Onboarding', folder: join(h.dir, 'b') });
    await h.call('POST', '/sessions', { sessionId: 's1', cwd: h.dir });
    await new Promise((r) => setTimeout(r, 5));
    await h.call('PUT', '/sessions/s1/initiative', { initiativeId: a.id });
    expect((await h.call('GET', '/initiatives/recent?limit=1')).body.map((s: { title: string }) => s.title)).toEqual(['Pricing']);
    expect((await h.call('GET', '/initiatives/recent')).body).toHaveLength(2);
    expect((await h.call('GET', '/initiatives/recent?limit=0')).status).toBe(400);
  });

  it('finds by words and needs q', async () => {
    const h = await startWithStore();
    await h.call('POST', '/initiatives', { title: 'Pricing', folder: join(h.dir, 'a'), understanding: 'Trials and plans.' });
    await h.call('POST', '/initiatives', { title: 'Onboarding', folder: join(h.dir, 'b') });
    const found = await h.call('GET', `/initiatives/find?q=${encodeURIComponent('pricing trial')}`);
    expect(found.body).toEqual([expect.objectContaining({ title: 'Pricing', score: 4 })]);
    expect((await h.call('GET', '/initiatives/find')).status).toBe(400);
  });

  it('attaches a live session, answers its snapshot, and detaches', async () => {
    const h = await startWithStore();
    const i = (await h.call('POST', '/initiatives', { title: 'Pricing', folder: h.dir, open: ['Legal'] })).body;
    expect((await h.call('PUT', '/sessions/s1/initiative', { initiativeId: i.id })).status).toBe(404);
    await h.call('POST', '/sessions', { sessionId: 's1', cwd: h.dir });

    const none = await h.call('GET', '/sessions/s1/initiative');
    expect(none.status).toBe(204);
    expect(none.raw.length).toBe(0);

    const attached = await h.call('PUT', '/sessions/s1/initiative', { initiativeId: i.id });
    expect(attached.body).toEqual({
      id: i.id,
      title: 'Pricing',
      revision: 1,
      attachmentRevision: 1,
      understanding: '',
      decisions: [],
      open: ['Legal'],
      folders: [{ path: '~', role: 'working' }],
    });
    expect((await h.call('GET', '/sessions/s1/initiative')).body).toEqual(attached.body);
    expect((await h.call('PUT', '/sessions/s1/initiative', { initiativeId: 'nope' })).status).toBe(404);

    expect((await h.call('DELETE', '/sessions/s1/initiative')).body).toEqual({ detached: true });
    expect((await h.call('GET', '/sessions/s1/initiative')).status).toBe(204);
    expect((await h.call('DELETE', '/sessions/gone/initiative')).body).toEqual({ detached: false });
  });

  it('rejects bad bodies', async () => {
    const h = await startWithStore();
    expect((await h.call('POST', '/initiatives', { title: 'x', folder: 'relative/path' })).status).toBe(400);
    expect((await h.call('POST', '/initiatives', { folder: h.dir })).status).toBe(400);
    const { body } = await h.call('POST', '/initiatives', { title: 'Pricing', folder: h.dir });
    expect((await h.call('PUT', `/initiatives/${body.id}`, { open: ['a'], updatedBy: 'PM' })).status).toBe(400);
    expect((await h.call('PUT', `/initiatives/${body.id}`, { revision: 1, open: ['a\nb'], updatedBy: 'PM' })).status).toBe(400);
    expect((await h.call('PUT', `/initiatives/${body.id}`, { revision: 1, folders: [{ path: '~/x', role: 'misc' }], updatedBy: 'PM' })).status).toBe(400);
    expect((await h.call('GET', '/initiatives/missing')).status).toBe(404);
  });

  it('answers 503 when the app keeps no initiatives', async () => {
    const h = await start();
    expect((await h.call('GET', '/initiatives')).status).toBe(503);
    expect((await h.call('GET', '/sessions/s1/initiative')).status).toBe(503);
  });
});
