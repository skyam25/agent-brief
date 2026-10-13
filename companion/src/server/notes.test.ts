import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NoteRequest } from '../protocol';
import { closeServers, start } from './server-testkit';

afterEach(closeServers);

const noting = () => ({ addNote: vi.fn((_req: NoteRequest) => ({ ok: true as const, draftId: 'd1' })) });

describe('POST /notes', () => {
  it('files a note under a live session and answers its draft id', async () => {
    const h = await start(noting());
    await h.call('POST', '/sessions', { sessionId: 'a', cwd: '/x' });
    const res = await h.call('POST', '/notes', { sessionId: 'a', title: '  Launch post ', text: 'We shipped **it**.' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, draftId: 'd1' });
    expect(h.backend.addNote).toHaveBeenCalledWith({ sessionId: 'a', title: 'Launch post', text: 'We shipped **it**.' });
  });

  it('takes a note with no session or title', async () => {
    const h = await start(noting());
    const res = await h.call('POST', '/notes', { text: 'loose' });
    expect(res.status).toBe(200);
    expect(h.backend.addNote).toHaveBeenCalledWith({ text: 'loose' });
  });

  it('never opens the panel or changes the Send target', async () => {
    const h = await start(noting());
    await h.call('POST', '/sessions', { sessionId: 'a', cwd: '/x' });
    await h.call('POST', '/notes', { sessionId: 'a', text: 'hi' });
    expect(h.backend.open).not.toHaveBeenCalled();
    expect(h.server.sessions().targetSessionId).toBeUndefined();
  });

  it('answers 404 for a session the app does not know', async () => {
    const h = await start(noting());
    const res = await h.call('POST', '/notes', { sessionId: 'gone', text: 'hi' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('not_found');
    expect(h.backend.addNote).not.toHaveBeenCalled();
  });

  it('refuses empty text, a long text and a title on two lines', async () => {
    const h = await start(noting());
    for (const body of [{}, { text: '  ' }, { text: 'x'.repeat(200_001) }, { text: 'hi', title: 'a\nb' }, { text: 'hi', title: 7 }]) {
      const res = await h.call('POST', '/notes', body);
      expect(res.status, JSON.stringify(body).slice(0, 40)).toBe(400);
      expect(res.body.code).toBe('bad_request');
    }
    expect(h.backend.addNote).not.toHaveBeenCalled();
  });

  it('answers 503 when the backend takes no notes', async () => {
    const h = await start();
    const res = await h.call('POST', '/notes', { text: 'hi' });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('unavailable');
  });
});
