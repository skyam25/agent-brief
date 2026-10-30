import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { outputsFile, type OutputRecord, type SessionInfo } from '../protocol';
import { InitiativeOutputs } from './initiative-outputs';

let root: string;
let watch: InitiativeOutputs | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ini-out-'));
});

afterEach(() => {
  watch?.close();
  rmSync(root, { recursive: true, force: true });
});

const PRD: OutputRecord = { ref: 'prd.md', title: 'PRD', kind: 'markdown', tier: 'declared', status: 'ready' };

const writeOutputs = (sessionId: string, outputs: OutputRecord[]) => {
  const file = outputsFile(root, sessionId);
  mkdirSync(join(root, '.feedback', 'outputs'), { recursive: true });
  writeFileSync(file, JSON.stringify({ version: 1, sessionId, outputs }));
};

function setup(attached: Record<string, string>) {
  const calls: { sessionId: string; refs: string[] }[] = [];
  const store = {
    attached: (id: string) => attached[id],
    recordOutputs: (sessionId: string, _cwd: string, records: readonly OutputRecord[]) => {
      calls.push({ sessionId, refs: records.map((r) => r.ref) });
      return true;
    },
  };
  const live: SessionInfo[] = [
    { sessionId: 's1', cwd: root },
    { sessionId: 's2', cwd: root },
  ];
  watch = new InitiativeOutputs(store, () => live, { debounceMs: 20, pollMs: 40 });
  return { calls };
}

describe('InitiativeOutputs', () => {
  it('files what an attached session has at once, then each change', async () => {
    writeOutputs('s1', [PRD]);
    writeOutputs('s2', [PRD]);
    const { calls } = setup({ s1: 'i1' });
    watch!.sync();
    expect(calls).toEqual([{ sessionId: 's1', refs: ['prd.md'] }]);
    watch!.sync();
    expect(calls).toHaveLength(1);
    writeOutputs('s1', [PRD, { ...PRD, ref: 'deck.html', kind: 'html' }]);
    await vi.waitFor(() => expect(calls.at(-1)).toEqual({ sessionId: 's1', refs: ['prd.md', 'deck.html'] }), { timeout: 2000 });
    expect(calls.every((c) => c.sessionId === 's1')).toBe(true);
  });

  it('waits for a file that does not exist yet', async () => {
    const { calls } = setup({ s1: 'i1' });
    watch!.sync();
    expect(calls).toEqual([]);
    writeOutputs('s1', [PRD]);
    await vi.waitFor(() => expect(calls).toEqual([{ sessionId: 's1', refs: ['prd.md'] }]), { timeout: 2000 });
  });
});
