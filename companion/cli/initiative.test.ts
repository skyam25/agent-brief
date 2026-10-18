import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { InitiativeStore } from '../src/main/initiatives';
import { INITIATIVE_NOT_RUNNING_MESSAGE } from './main';
import { fail, useFakeApp } from './testkit';

const { app, run } = useFakeApp();

const SUMMARIES = [
  { id: 'aa11', title: 'Pricing', lastActiveAt: '2026-10-17T10:00:00Z', line: 'Monthly-first.' },
  { id: 'bb22', title: 'Onboarding', lastActiveAt: '2026-10-16T10:00:00Z', line: '' },
];

/** The app closed: no socket, and a data folder holding briefs a writable store made. */
function closedApp() {
  const data = path.join(app.dir, 'data');
  const store = new InitiativeStore(data, { home: app.dir });
  const pricing = store.create({ title: 'Pricing', folder: path.join(app.dir, 'Pricing'), understanding: 'Monthly-first. Then legal.', open: ['Legal'] });
  store.create({ title: 'Onboarding', folder: path.join(app.dir, 'Onboarding'), decisions: ['2026-10-01 Email first'] });
  store.attach('s1', pricing.id);
  const env = { COMPANION_SOCKET: path.join(app.dir, 'none.sock'), COMPANION_DATA_DIR: data };
  return { env, pricing, data };
}

describe('initiative reads with the app closed', () => {
  it('lists, finds and shows from the index and the brief files', async () => {
    const { env, pricing } = closedApp();
    const list = await run(['initiative', 'list'], '', env);
    expect(list.code).toBe(0);
    expect(list.stdout).toBe(`${pricing.id}  Pricing · Monthly-first.\n${JSON.parse((await run(['initiative', 'list', '--json'], '', env)).stdout)[1].id}  Onboarding\n`);

    const recent = await run(['initiative', 'recent', '--limit', '1', '--json'], '', env);
    expect(JSON.parse(recent.stdout).map((s: { title: string }) => s.title)).toEqual(['Pricing']);

    const found = await run(['initiative', 'find', 'email'], '', env);
    expect(found.stdout).toContain('Onboarding');
    expect(found.stdout).toContain('(score 1)');

    const shown = await run(['initiative', 'show', 'pricing'], '', env);
    expect(shown.code).toBe(0);
    expect(shown.stdout).toContain(`Pricing  (id ${pricing.id}, revision 1`);
    expect(shown.stdout).toContain('Attached: s1');
    expect(shown.stdout).toContain('Understanding\nMonthly-first. Then legal.');
    expect(shown.stdout).toContain('Open\n- Legal');
    expect(shown.stdout).toContain('Folders\n- ~/Pricing → working');
  });

  it('reads an edit made by hand without recording it', async () => {
    const { env, pricing, data } = closedApp();
    fs.writeFileSync(pricing.path, fs.readFileSync(pricing.path, 'utf8').replace('- Legal', '- Legal\n- By hand'));
    const before = fs.readFileSync(path.join(data, 'initiatives.json'), 'utf8');
    const shown = JSON.parse((await run(['initiative', 'show', pricing.id, '--json'], '', env)).stdout);
    expect(shown).toMatchObject({ open: ['Legal', 'By hand'], revision: 1 });
    expect(fs.readFileSync(path.join(data, 'initiatives.json'), 'utf8')).toBe(before);
  });

  it('exits 3 on a write', async () => {
    const { env } = closedApp();
    for (const argv of [
      ['initiative', 'attach', 'Pricing', '--session', 's2'],
      ['initiative', 'detach', '--session', 's2'],
      ['initiative', 'create', 'Checkout', '--folder', app.dir],
    ]) {
      const r = await run(argv, '', env);
      expect(r.code).toBe(3);
      expect(r.stderr).toBe(`${INITIATIVE_NOT_RUNNING_MESSAGE}\n`);
    }
    const update = await run(['initiative', 'update', 'Pricing'], '{"revision":1,"open":[]}', env);
    expect(update.code).toBe(3);
  });

  it('names a title nothing matches', async () => {
    const { env } = closedApp();
    const r = await run(['initiative', 'show', 'Billing'], '', env);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('no initiative matches "Billing"');
  });
});

describe('initiative with the app running', () => {
  it('reads through the socket', async () => {
    app.handler = () => ({ json: SUMMARIES });
    const r = await run(['initiative', 'recent']);
    expect(app.seen[0]).toMatchObject({ method: 'GET', url: '/initiatives/recent?limit=3' });
    expect(r.stdout).toBe('aa11  Pricing · Monthly-first.\nbb22  Onboarding\n');
  });

  it('attaches by title to the session that runs it', async () => {
    app.handler = (req) =>
      req.method === 'GET'
        ? { json: SUMMARIES }
        : { json: { id: 'aa11', title: 'Pricing', revision: 4, attachmentRevision: 1, understanding: '', decisions: [], open: [], folders: [] } };
    const r = await run(['initiative', 'attach', 'Pricing'], '', { CLAUDE_CODE_SESSION_ID: 's9' });
    expect(r.code).toBe(0);
    expect(app.seen[1]).toEqual({ method: 'PUT', url: '/sessions/s9/initiative', body: { initiativeId: 'aa11' } });
    expect(r.stdout).toBe('attached "Pricing" (revision 4) to session s9\n');
  });

  it('needs a session to attach', async () => {
    app.handler = () => ({ json: SUMMARIES });
    expect((await run(['initiative', 'attach', 'Pricing'])).code).toBe(2);
  });

  it('creates with a draft and resolves the folder', async () => {
    fs.writeFileSync(path.join(app.dir, 'draft.json'), JSON.stringify({ understanding: 'Start.', working: ['Page · v1'] }));
    app.handler = () => ({ json: { id: 'cc33', title: 'Checkout', path: '/x/Checkout brief.md' } });
    const r = await run(['initiative', 'create', 'Checkout', '--folder', 'projects/checkout', '--file', 'draft.json'], '', { CLAUDE_CODE_SESSION_ID: 's9' });
    expect(r.code).toBe(0);
    expect(app.seen[0]).toEqual({
      method: 'POST',
      url: '/initiatives',
      body: { updatedBy: 'Claude · s9', understanding: 'Start.', working: ['Page · v1'], title: 'Checkout', folder: path.join(app.dir, 'projects/checkout') },
    });
  });

  it('updates with the revision and reports a conflict', async () => {
    app.handler = (req) => (req.method === 'GET' ? { json: SUMMARIES } : fail('conflict', 'revision 3 is stale', 409)(req));
    const r = await run(['initiative', 'update', 'aa11'], '{"revision":3,"open":["Legal"]}', { CLAUDE_CODE_SESSION_ID: 's9' });
    expect(app.seen[1]).toEqual({ method: 'PUT', url: '/initiatives/aa11', body: { updatedBy: 'Claude · s9', revision: 3, open: ['Legal'] } });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('error (conflict): revision 3 is stale');
    expect((await run(['initiative', 'update', 'aa11'], '{"open":[]}')).code).toBe(2);
  });

  it('rejects an unknown verb', async () => {
    const r = await run(['initiative', 'archive']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('initiative takes list, recent, find, show');
  });
});
