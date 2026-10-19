import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { harness } from '../src/server/testkit';
import { main } from './main';

let h: ReturnType<typeof harness>;

beforeEach(async () => {
  h = harness();
  await h.server.listen();
});

afterEach(async () => {
  await h.server.close();
  fs.rmSync(h.dir, { recursive: true, force: true });
});

async function run(argv: string[], stdin = '') {
  let stdout = '';
  let stderr = '';
  const code = await main(argv, {
    stdin: async () => stdin,
    stdout: (s) => (stdout += s),
    stderr: (s) => (stderr += s),
    env: { COMPANION_SOCKET: h.socketPath },
    cwd: h.dir,
  });
  return { code, stdout, stderr };
}

it('talks to the real server', async () => {
  expect((await run(['status'])).stdout).toContain('running');

  const draw = await run(['draw'], '[{"type":"text","label":"hi","x":0,"y":0}]');
  expect(draw.code).toBe(0);
  expect(draw.stdout).toContain('b1');
  expect(h.backend.draw).toHaveBeenCalledWith('current', {
    elements: [{ type: 'text', label: 'hi', x: 0, y: 0 }],
  });

  const del = await run(['delete', 'a', 'b']);
  expect(del.code).toBe(0);
  expect(h.backend.remove).toHaveBeenCalledWith('current', { ids: ['a', 'b'] });

  const out = path.join(h.dir, 'p.png');
  expect((await run(['png', '--out', out, '--region', '0,0,10,10', '--max-edge', '500'])).code).toBe(0);
  expect(fs.readFileSync(out).length).toBe(4);
  expect(h.backend.png).toHaveBeenCalledWith('current', {
    region: { x: 0, y: 0, width: 10, height: 10 },
    maxEdge: 500,
  });

  expect((await run(['read'])).stdout).toContain('0 elements');
  expect((await run(['boards'])).code).toBe(0);
  expect((await run(['sessions'])).stdout).toContain('no sessions');
});

it('opens an output of the session running it through the real server', async () => {
  const project = path.join(h.dir, 'proj');
  fs.mkdirSync(path.join(project, 'docs'), { recursive: true });
  await h.call('POST', '/sessions', { sessionId: 's1', cwd: project });
  const env = { CLAUDE_CODE_SESSION_ID: 's1' };
  const inside = (argv: string[], cwd: string) =>
    main(argv, { stdin: async () => '', stdout: () => {}, stderr: () => {}, env: { COMPANION_SOCKET: h.socketPath, ...env }, cwd });

  expect(await inside(['open', '--output', 'brief.md'], path.join(project, 'docs'))).toBe(0);
  expect(h.backend.open).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: 's1', output: { path: 'docs/brief.md' } }));

  expect(await inside(['open'], project)).toBe(0);
  expect(h.backend.open).toHaveBeenLastCalledWith({ sessionId: 's1' });
});
