import { describe, expect, it } from 'vitest';
import type { OutputRecord } from '../protocol';
import type { OutputsInfo } from '../shared/ipc';
import { OutputsStore } from './outputs';

const doc: OutputRecord = { ref: 'docs/pricing.md', kind: 'markdown', tier: 'declared', status: 'drafting', declaredAt: 1 };
const info = (outputs: OutputRecord[] = [doc], sessionId = 's1'): OutputsInfo => ({
  sessionId,
  path: `/p/.feedback/outputs/${sessionId}.json`,
  exists: true,
  outputs,
});

function store(read: OutputsInfo | undefined = info()) {
  let push: (i: OutputsInfo) => void = () => undefined;
  const outputs = new OutputsStore({ readOutputs: async () => read, onOutputs: (fn) => void (push = fn) });
  return { outputs, push: (i: OutputsInfo) => push(i) };
}

describe('OutputsStore', () => {
  it('holds the Feedback view /open asked for until Review takes it once', () => {
    const { outputs } = store();
    let calls = 0;
    outputs.subscribe(() => calls++);
    outputs.askFeedback('s1', 'docs/prd.md');
    expect(calls).toBe(1);
    expect(outputs.takeFeedback('s2')).toBeUndefined();
    expect(outputs.takeFeedback('s1')).toBe('docs/prd.md');
    expect(outputs.takeFeedback('s1')).toBeUndefined();
  });

  it('loads a session and takes pushed changes, bumping its version', async () => {
    const { outputs, push } = store();
    let calls = 0;
    outputs.subscribe(() => calls++);
    expect(outputs.info('s1')).toBeUndefined();
    await outputs.load('s1');
    expect(outputs.info('s1')?.outputs).toEqual([doc]);
    const v = outputs.version;
    push(info([{ ...doc, status: 'ready' }]));
    expect(outputs.info('s1')?.outputs[0]?.status).toBe('ready');
    expect(outputs.version).toBe(v + 1);
    push(info([], 's2'));
    expect(outputs.info('s2')?.outputs).toEqual([]);
    expect(outputs.info('s1')?.outputs).toHaveLength(1);
    expect(calls).toBe(3);
  });

  it('keeps the last copy when main has nothing for the session', async () => {
    const { outputs, push } = store(undefined);
    push(info());
    await outputs.load('s1');
    expect(outputs.info('s1')?.outputs).toEqual([doc]);
  });
});
