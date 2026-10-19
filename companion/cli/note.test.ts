import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { main, NOTE_NOT_RUNNING_MESSAGE } from './main';
import { fail, useFakeApp } from './testkit';

const { app, run } = useFakeApp();
const SESSION = { CLAUDE_CODE_SESSION_ID: 'sess-1' };

describe('note', () => {
  it('posts stdin as a note filed under the Claude Code session that runs it', async () => {
    app.handler = () => ({ json: { ok: true, draftId: 'd1' } });
    const r = await run(['note', 'Launch', 'message'], 'Hi team, **v2 is live**.\n', SESSION);
    expect(r.code).toBe(0);
    expect(app.seen).toEqual([
      { method: 'POST', url: '/notes', body: { text: 'Hi team, **v2 is live**.\n', title: 'Launch message', sessionId: 'sess-1' } },
    ]);
    expect(r.stdout).toContain(`Saved "Launch message" to this session's tab`);
    expect(r.stdout).toContain('To show it, run: agent-brief open --note d1');
  });

  it('takes --text or --file, and --session over the environment', async () => {
    app.handler = () => ({ json: { ok: true, draftId: 'd1' } });
    await run(['note', '--text', 'inline', '--session', 'other'], '', SESSION);
    fs.writeFileSync(path.join(app.dir, 'post.md'), '# Post\n');
    await run(['note', 'From file', '--file', 'post.md']);
    expect(app.seen.map((s) => s.body)).toEqual([
      { text: 'inline', sessionId: 'other' },
      { text: '# Post\n', title: 'From file' },
    ]);
  });

  it('files under Notes when the app has not met the session from the environment', async () => {
    app.handler = (req) =>
      (req.body as { sessionId?: string }).sessionId ? fail('not_found', 'no session sess-1', 404)(req) : { json: { ok: true, draftId: 'd2' } };
    const r = await run(['note', 'Email'], 'Dear Sam', SESSION);
    expect(r.code).toBe(0);
    expect(app.seen.map((s) => s.body)).toEqual([
      { text: 'Dear Sam', title: 'Email', sessionId: 'sess-1' },
      { text: 'Dear Sam', title: 'Email' },
    ]);
    expect(r.stdout).toContain('to Notes');
  });

  it('fails on an unknown session named with --session', async () => {
    app.handler = fail('not_found', 'no session nope', 404);
    const r = await run(['note', '--session', 'nope'], 'text');
    expect(r.code).toBe(1);
    expect(app.seen).toHaveLength(1);
  });

  it('refuses empty text and both --text and --file before calling the app', async () => {
    expect((await run(['note', 'Empty'], '  \n')).code).toBe(2);
    expect((await run(['note', '--text', 'a', '--file', 'b.md'])).code).toBe(2);
    expect(app.seen).toHaveLength(0);
  });

  it('exits 3 with a print-it-instead message when the app is not running', async () => {
    let stderr = '';
    const code = await main(['note', 'Post'], {
      stdin: async () => 'text',
      stdout: () => undefined,
      stderr: (s) => (stderr += s),
      env: { COMPANION_SOCKET: path.join(app.dir, 'missing.sock') },
    });
    expect(code).toBe(3);
    expect(stderr.trim()).toBe(NOTE_NOT_RUNNING_MESSAGE);
  });

  it('prints the draft id with --json', async () => {
    app.handler = () => ({ json: { ok: true, draftId: 'd9' } });
    const r = await run(['note', '--json'], 'x', SESSION);
    expect(JSON.parse(r.stdout)).toEqual({ ok: true, draftId: 'd9', sessionId: 'sess-1' });
  });

  it('replaces a note in place with --id, keeping where it is filed', async () => {
    app.handler = () => ({ json: { ok: true, draftId: 'd7' } });
    const r = await run(['note', '--id', 'd7'], 'Shorter text', SESSION);
    expect(r.code).toBe(0);
    expect(app.seen.map((s) => s.body)).toEqual([{ text: 'Shorter text', draftId: 'd7' }]);
    expect(r.stdout).toContain('Updated note d7 in place');
    expect(r.stdout).toContain('agent-brief open --note d7');
    expect((await run(['note', '--id', 'd7', '--session', 's'], 'x')).code).toBe(2);
  });
});
