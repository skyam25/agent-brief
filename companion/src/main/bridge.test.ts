import type { WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { RendererBridge } from './bridge';

function fakeContents() {
  const sent: { channel: string; req: { id: number; op: string } }[] = [];
  const wc = {
    isDestroyed: () => false,
    send: vi.fn((channel: string, req: { id: number; op: string }) => sent.push({ channel, req })),
  };
  return { wc: wc as unknown as WebContents, sent };
}

describe('RendererBridge', () => {
  it('answers a request with the renderer reply', async () => {
    const { wc, sent } = fakeContents();
    const bridge = new RendererBridge(() => wc);
    bridge.ready();
    const p = bridge.request('read', { board: 'b' }, 1000);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    bridge.handleReply({ id: sent[0].req.id, ok: true, result: { board: 'b', elements: [], bounds: {} } });
    await expect(p).resolves.toMatchObject({ board: 'b' });
  });

  it('fails with unavailable when the renderer never answers, instead of hanging', async () => {
    const { wc } = fakeContents();
    const bridge = new RendererBridge(() => wc);
    bridge.ready();
    const started = Date.now();
    await expect(bridge.request('draw', { board: 'b', req: { elements: [] }, batchId: 'x' }, 50)).rejects.toMatchObject({
      code: 'unavailable',
      message: 'panel did not answer draw in 50 ms',
    });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('fails with unavailable when the panel never becomes ready', async () => {
    const { wc, sent } = fakeContents();
    const bridge = new RendererBridge(() => wc);
    await expect(bridge.request('read', { board: 'b' }, 30)).rejects.toMatchObject({ code: 'unavailable', message: 'panel is not ready' });
    expect(sent).toHaveLength(0);
  });

  it('keeps known error codes from the renderer and turns others into internal', async () => {
    const { wc, sent } = fakeContents();
    const bridge = new RendererBridge(() => wc);
    bridge.ready();
    const a = bridge.request('read', { board: 'b' }, 1000);
    const b = bridge.request('read', { board: 'b' }, 1000);
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    bridge.handleReply({ id: sent[0].req.id, ok: false, error: { message: 'no arrow end', code: 'bad_request' } });
    bridge.handleReply({ id: sent[1].req.id, ok: false, error: { message: 'boom' } });
    await expect(a).rejects.toMatchObject({ code: 'bad_request', message: 'no arrow end' });
    await expect(b).rejects.toMatchObject({ code: 'internal', message: 'boom' });
  });

  it('fails requests in flight when the panel reloads', async () => {
    const { wc, sent } = fakeContents();
    const bridge = new RendererBridge(() => wc);
    bridge.ready();
    const p = bridge.request('read', { board: 'b' }, 5000);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    bridge.reset();
    await expect(p).rejects.toMatchObject({ code: 'unavailable', message: 'panel reloaded' });
    bridge.handleReply({ id: sent[0].req.id, ok: true, result: {} });
  });
});
