import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { useFakeApp } from './testkit';

const { app } = useFakeApp();

describe('built binary', () => {
  it('runs bin/agent-brief.mjs against the fake server', async () => {
    app.handler = () => ({ json: { ids: ['a'], batchId: 'bb' } });
    const bin = path.resolve(__dirname, '../bin/agent-brief.mjs');
    const result = await new Promise<{ code: number; stdout: string }>((ok) => {
      const child = execFile(
        'node', [bin, 'draw'],
        { env: { ...process.env, COMPANION_SOCKET: app.socket } },
        (error, stdout) => ok({ code: error ? (error as { code?: number }).code ?? 1 : 0, stdout }),
      );
      child.stdin!.end('[{"type":"text","label":"hi","x":0,"y":0}]');
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('batch bb');
    expect(app.seen[0].body).toEqual({ elements: [{ type: 'text', label: 'hi', x: 0, y: 0 }] });
  });

  it('exits 3 when the app is not running', async () => {
    const bin = path.resolve(__dirname, '../bin/agent-brief.mjs');
    const result = await new Promise<{ code: number; stderr: string }>((ok) => {
      execFile('node', [bin, 'status'], { env: { ...process.env, COMPANION_SOCKET: path.join(app.dir, 'none.sock') } },
        (error, _o, stderr) => ok({ code: (error as { code?: number } | null)?.code ?? 0, stderr }));
    });
    expect(result.code).toBe(3);
    expect(result.stderr).toContain('not running');
  });
});

describe('bin/agent-brief wrapper', () => {
  const wrapper = path.resolve(__dirname, '../bin/agent-brief');

  function exec(file: string, args: string[], stdin?: string) {
    return new Promise<{ code: number; stdout: string }>((ok) => {
      const child = execFile(file, args, { env: { ...process.env, COMPANION_SOCKET: app.socket } },
        (error, stdout) => ok({ code: (error as { code?: number } | null)?.code ?? 0, stdout }));
      child.stdin!.end(stdin ?? '');
    });
  }

  it('runs through a symlink, as ~/.local/bin/agent-brief does', async () => {
    app.handler = () => ({ json: { ids: ['a'], batchId: 'bb' } });
    const link = path.join(app.dir, 'agent-brief');
    fs.symlinkSync(wrapper, link);
    const result = await exec(link, ['draw'], '[{"type":"text","label":"hi","x":0,"y":0}]');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('batch bb');
  });

  it("uses the app's Electron as Node inside a bundle", async () => {
    const contents = path.join(app.dir, 'X.app', 'Contents');
    fs.mkdirSync(path.join(contents, 'Resources', 'bin'), { recursive: true });
    fs.mkdirSync(path.join(contents, 'MacOS'));
    fs.copyFileSync(wrapper, path.join(contents, 'Resources', 'bin', 'agent-brief'));
    const electron = path.join(contents, 'MacOS', 'Agent Brief');
    fs.writeFileSync(electron, '#!/bin/sh\necho "run-as-node=$ELECTRON_RUN_AS_NODE $*"\n', { mode: 0o755 });
    const link = path.join(app.dir, 'agent-brief');
    fs.symlinkSync(path.join(contents, 'Resources', 'bin', 'agent-brief'), link);

    const result = await exec(link, ['status']);
    expect(result.stdout.trim()).toBe(`run-as-node=1 ${path.join(contents, 'Resources', 'bin', 'agent-brief.mjs')} status`);
  });
});
