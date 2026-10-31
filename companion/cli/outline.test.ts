import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { OutlineDocument, OutlineProject, OutlineUpdate } from '../src/protocol';
import { applyOutlineOps, outlineSummary, parseOutline, serializeOutline } from '../src/shared/outline';
import { main, NOT_RUNNING_MESSAGE } from './main';
import { fail, type Handler, type Seen, useFakeApp } from './testkit';

const { app, run } = useFakeApp();
const SESSION = { CLAUDE_CODE_SESSION_ID: 'sess-1' };
const ROUTE = '/sessions/sess-1/outline';

const MEMO = `# Onboarding memo

Target: docs/memo.md
Kind: document

## Why change onboarding now ^s1
- New accounts wait a median 6 business days. ^p1
    Cite: S1 · wait times
- Open: Can support absorb async Q&A? ^p2
    Default: assume no new hire

## Sources
- S1 · CS ops dashboard export
    Ref: data/cs-ops.csv
`;

/** A one-file outline store behind the outline routes. A POST with a stale version fails. */
function outlineStore(files: Record<string, string>): Handler {
  let version = 1;
  return (req: Seen) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === `${ROUTE}/project`) {
      const project: OutlineProject = { files: Object.entries(files).map(([p, t]) => outlineSummary(p, parseOutline(t))) };
      return { json: project };
    }
    if (url.pathname === '/open') return { json: { ok: true, opened: 'note', board: 'main' } };
    const file = url.searchParams.get('path')!;
    const doc = (): OutlineDocument =>
      files[file] === undefined
        ? { path: file, version: 'missing', title: '', kind: 'document', intent: [], sections: [], sources: [] }
        : { ...parseOutline(files[file]), path: file, version: `v${version}` };
    if (req.method === 'GET') return { json: doc() };
    const body = req.body as OutlineUpdate;
    if (body.version !== undefined && body.version !== doc().version) {
      return fail('conflict', `${file} changed since version ${body.version}`, 409)(req);
    }
    try {
      const { text, added } = applyOutlineOps(files[file], { ops: body.ops, date: '2026-10-25' });
      files[file] = text;
      version++;
      return { json: { ...doc(), added } };
    } catch (e) {
      return fail('bad_request', (e as Error).message)(req);
    }
  };
}

describe('outline', () => {
  it('lists outlines with their counts', async () => {
    app.handler = outlineStore({ 'docs/memo.outline.md': MEMO, 'idea.outline.md': '# Idea\n\nKind: page\n' });
    const r = await run(['outline', 'list'], '', SESSION);
    expect(r.code).toBe(0);
    expect(app.seen[0]).toMatchObject({ method: 'GET', url: `${ROUTE}/project` });
    expect(r.stdout).toBe(
      'docs/memo.outline.md · "Onboarding memo" · docs/memo.md · 1 section · 2 points · 1 open · 1 unchecked · 0 flagged\n' +
        'idea.outline.md · "Idea" · no target (page) · 0 sections · 0 points · 0 open · 0 unchecked · 0 flagged\n',
    );
  });

  it('says so when the project has none', async () => {
    app.handler = () => ({ json: { files: [] } });
    const r = await run(['outline', 'list', '--session', 'other']);
    expect(app.seen[0].url).toBe('/sessions/other/outline/project');
    expect(r.stdout).toContain('no outlines in this project');
  });

  it('shows the version and the canonical text, or JSON', async () => {
    app.handler = outlineStore({ 'docs/memo.outline.md': MEMO });
    const r = await run(['outline', 'show', 'docs/memo.outline.md'], '', SESSION);
    expect(r.code).toBe(0);
    expect(app.seen[0].url).toBe(`${ROUTE}?path=docs%2Fmemo.outline.md`);
    expect(r.stdout).toBe(`docs/memo.outline.md · version v1\n${MEMO}`);
    const json = JSON.parse((await run(['outline', 'show', 'docs/memo.outline.md', '--json'], '', SESSION)).stdout);
    expect(json).toMatchObject({ path: 'docs/memo.outline.md', version: 'v1', title: 'Onboarding memo' });
  });

  it('says a missing outline has none yet', async () => {
    app.handler = outlineStore({});
    const r = await run(['outline', 'show', 'x.outline.md'], '', SESSION);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('x.outline.md · no outline yet');
  });

  it('makes an outline beside its target and opens it in Write', async () => {
    const files: Record<string, string> = {};
    app.handler = outlineStore(files);
    const r = await run(['outline', 'new', 'Onboarding memo', '--target', 'docs/memo.md'], '', SESSION);
    expect(r.code).toBe(0);
    expect(r.stdout.split('\n')[0]).toBe('docs/memo.outline.md');
    expect(r.stdout).toContain('opened in Write');
    expect(app.seen.map((s) => [s.method, s.url, s.body])).toEqual([
      ['POST', `${ROUTE}?path=docs%2Fmemo.outline.md`, { version: 'missing', ops: [{ op: 'setMeta', title: 'Onboarding memo', target: 'docs/memo.md' }] }],
      ['POST', '/open', { sessionId: 'sess-1', output: { path: 'docs/memo.outline.md' } }],
    ]);
    expect(files['docs/memo.outline.md']).toBe('# Onboarding memo\n\nTarget: docs/memo.md\nKind: document\n');
  });

  it('names a new outline by --path, else by its title, and skips the panel with --no-open', async () => {
    const files: Record<string, string> = {};
    app.handler = outlineStore(files);
    const slug = await run(['outline', 'new', 'Checkout Page!', '--kind', 'page', '--no-open'], '', SESSION);
    expect(slug.stdout.split('\n')[0]).toBe('checkout-page.outline.md');
    expect(slug.stdout).toContain('not opened');
    const named = await run(['outline', 'new', 'Plan', '--path', 'notes/plan.outline.md', '--no-open'], '', SESSION);
    expect(named.stdout.split('\n')[0]).toBe('notes/plan.outline.md');
    expect(app.seen.some((s) => s.url === '/open')).toBe(false);
    expect(Object.keys(files)).toEqual(['checkout-page.outline.md', 'notes/plan.outline.md']);
    expect(files['checkout-page.outline.md']).toContain('Kind: page');
  });

  it('refuses to make an outline that exists', async () => {
    app.handler = outlineStore({ 'docs/memo.outline.md': MEMO });
    const r = await run(['outline', 'new', 'Again', '--target', 'docs/memo.md'], '', SESSION);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('docs/memo.outline.md already exists');
    expect(app.seen).toHaveLength(1);
  });

  it('keeps the new file when the panel cannot open it', async () => {
    const store = outlineStore({});
    app.handler = (req) => (req.url === '/open' ? fail('not_found', 'no session sess-1', 404)(req) : store(req));
    const r = await run(['outline', 'new', 'Memo'], '', SESSION);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('memo.outline.md\nmade "Memo" · not opened: no session sess-1\n');
  });

  it('applies ops from a file to the outline as it stands, and prints the ids added', async () => {
    const files = { 'docs/memo.outline.md': MEMO };
    app.handler = outlineStore(files);
    fs.mkdirSync(path.join(app.dir, '.feedback'));
    const ops = [
      { op: 'addSection', title: 'Options' },
      { op: 'addPoint', section: 's2', text: 'Keep the kickoff call for large accounts.' },
      { op: 'editSource', id: 'S1', checked: '2026-10-25' },
    ];
    fs.writeFileSync(path.join(app.dir, '.feedback/outline-ops.json'), JSON.stringify(ops));
    const r = await run(['outline', 'apply', 'docs/memo.outline.md', '--ops', '.feedback/outline-ops.json'], '', SESSION);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('applied 3 ops · added s2 p3\n');
    expect(app.seen.map((s) => s.method)).toEqual(['POST']);
    expect((app.seen[0].body as OutlineUpdate).version).toBeUndefined();
    expect(files['docs/memo.outline.md']).toContain('## Options ^s2\n- Keep the kickoff call for large accounts. ^p3');
    expect(serializeOutline(parseOutline(files['docs/memo.outline.md']))).toBe(files['docs/memo.outline.md']);
  });

  it('takes {"ops": [...]} on stdin with --ops -', async () => {
    app.handler = outlineStore({ 'docs/memo.outline.md': MEMO });
    const r = await run(['outline', 'apply', 'docs/memo.outline.md', '--ops', '-'], JSON.stringify({ ops: [{ op: 'removePoint', id: 'p2' }] }), SESSION);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('applied 1 op\n');
  });

  it('reports an op the app rejects', async () => {
    app.handler = outlineStore({ 'docs/memo.outline.md': MEMO });
    const r = await run(['outline', 'apply', 'docs/memo.outline.md', '--ops', '-'], '[{"op":"removePoint","id":"p9"}]', SESSION);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('error (bad_request): ops[0] removePoint');
  });

  it('rejects bad input before calling the app', async () => {
    const cases: [string[], string][] = [
      [['outline', 'apply', 'docs/memo.outline.md', '--ops', '-'], 'not json'],
      [['outline', 'apply', 'docs/memo.outline.md', '--ops', '-'], '[{"op":"nope"}]'],
      [['outline', 'apply', 'docs/memo.outline.md', '--ops', '-'], '[]'],
      [['outline', 'apply', 'docs/memo.outline.md'], ''],
      [['outline', 'apply', 'docs/memo.md', '--ops', '-'], '[{"op":"clearDirection"}]'],
      [['outline', 'show'], ''],
      [['outline', 'new'], ''],
      [['outline', 'new', 'Memo', '--kind', 'slides'], ''],
      [['outline', 'new', 'Memo', '--target', '../out.md'], ''],
      [['outline', 'new', 'Memo', '--path', 'memo.md'], ''],
      [['outline', 'rename'], ''],
      [['outline'], ''],
    ];
    for (const [argv, stdin] of cases) {
      const r = await run(argv, stdin, SESSION);
      expect(r.code, argv.join(' ')).toBe(2);
      expect(r.stderr).toMatch(/^error: /);
    }
    expect(app.seen).toHaveLength(0);
  });

  it('needs a session', async () => {
    const r = await run(['outline', 'list']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('outline needs --session <id>');
    expect(app.seen).toHaveLength(0);
  });

  it('exits 3 when the app is not running', async () => {
    let stderr = '';
    const code = await main(['outline', 'list'], {
      stdin: async () => '',
      stdout: () => undefined,
      stderr: (s) => (stderr += s),
      env: { COMPANION_SOCKET: path.join(app.dir, 'missing.sock'), ...SESSION },
    });
    expect(code).toBe(3);
    expect(stderr.trim()).toBe(NOT_RUNNING_MESSAGE);
  });

  it('documents its verbs', async () => {
    const r = await run(['outline', '--help']);
    expect(r.code).toBe(0);
    for (const verb of ['list', 'new', 'show', 'apply', '--no-open', '--ops']) expect(r.stdout).toContain(verb);
  });
});
