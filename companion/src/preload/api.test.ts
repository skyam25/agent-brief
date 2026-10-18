import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { CH, IPC_EVENT, IPC_INVOKE, IPC_SEND, type BoardReply, type CompanionApi } from '../shared/ipc';
import { createPreloadApi } from './api';
import { mainIpc } from '../main/ipc';

function bridge() {
  const events = new EventEmitter();
  const invoke = vi.fn(async (_channel: string, ..._args: unknown[]): Promise<unknown> => 'result');
  const send = vi.fn();
  const api = createPreloadApi({
    invoke, send,
    on: (channel, listener) => events.on(channel, listener),
    removeListener: (channel, listener) => events.removeListener(channel, listener),
  });
  return { api, events, invoke, send };
}

describe('allowlisted IPC API', () => {
  it('exposes exactly the contract and forwards every invocation and one-way message', async () => {
    const { api, invoke, send } = bridge();
    expect(Object.keys(api).sort()).toEqual([...Object.keys(IPC_INVOKE), ...Object.keys(IPC_SEND), ...Object.keys(IPC_EVENT), 'onRequest'].sort());
    const methods = api as unknown as Record<string, (...args: unknown[]) => unknown>;
    for (const [method, channel] of Object.entries(IPC_INVOKE)) {
      expect(await methods[method]('id', { value: 2 })).toBe('result');
      expect(invoke).toHaveBeenLastCalledWith(channel, 'id', { value: 2 });
    }
    for (const [method, channel] of Object.entries(IPC_SEND)) {
      methods[method]('write');
      expect(send).toHaveBeenLastCalledWith(channel, 'write');
    }
    expect(IPC_INVOKE.getUpdate).toBe('update:get');
    expect(IPC_INVOKE.requestMicrophone).toBe('mic:request');
    expect(IPC_SEND.hidePanel).toBe('panel:hide');
  });

  it('strips privileged events and removes every subscription without removing other listeners', () => {
    const { api, events } = bridge();
    const methods = api as unknown as Record<string, (callback: (...args: unknown[]) => void) => () => void>;
    for (const [method, channel] of Object.entries(IPC_EVENT)) {
      const callback = vi.fn();
      const other = vi.fn();
      events.on(channel, other);
      const off = methods[method](callback);
      events.emit(channel, { sender: 'privileged' }, { value: 3 });
      expect(callback).toHaveBeenCalledExactlyOnceWith({ value: 3 });
      off();
      events.emit(channel, {}, { value: 4 });
      expect(callback).toHaveBeenCalledTimes(1);
      expect(other).toHaveBeenCalledTimes(2);
      events.removeListener(channel, other);
    }
  });

  it('normalizes legacy draft and empty note events', () => {
    const { api, events } = bridge();
    const note = vi.fn();
    const draft = vi.fn();
    api.onNewNote(note);
    api.onOpenDraft(draft);
    events.emit(CH.newNote, {});
    events.emit(CH.openDraft, {}, 'd1');
    events.emit(CH.openDraft, {}, { id: 'd2', sessionId: 's1' });
    expect(note).toHaveBeenCalledWith({});
    expect(draft.mock.calls).toEqual([[{ id: 'd1' }], [{ id: 'd2', sessionId: 's1' }]]);
  });

  it('returns board replies and can dispose its request handler', async () => {
    const { api, events, send } = bridge();
    const reply: BoardReply = { id: 7, ok: true, result: { board: 'scratch' } };
    const handler = vi.fn(async () => reply);
    const off = api.onRequest(handler);
    const request = { id: 7, op: 'show', args: { board: 'scratch' } };
    events.emit(CH.request, { sender: 'privileged' }, request);
    await Promise.resolve();
    expect(handler).toHaveBeenCalledWith(request);
    expect(send).toHaveBeenCalledWith(CH.reply, reply);
    if (typeof off === 'function') off();
    events.emit(CH.request, {}, request);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('connects typed main handlers to preload calls and preserves rejection', async () => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    const messages = new Map<string, (event: unknown, ...args: unknown[]) => void>();
    const main = mainIpc({ handle: (ch, fn) => { handlers.set(ch, fn); }, on: (ch, fn) => { messages.set(ch, fn); } });
    const mode = vi.fn<(mode: Parameters<CompanionApi['setMode']>[0]) => void>();
    main.on('setMode', mode);
    main.handle('openUnfiled', () => ({ board: 'scratch' }));
    main.handle('loadBoard', (name) => ({ scene: name, notes: 'kept' }));
    main.handle('deleteBoard', () => { throw new Error('Open another board'); });
    const api = createPreloadApi({
      invoke: async (ch, ...args) => handlers.get(ch)!({ sender: 'privileged' }, ...args),
      send: (ch, ...args) => messages.get(ch)!({}, ...args),
      on() {}, removeListener() {},
    });
    expect(await api.openUnfiled()).toEqual({ board: 'scratch' });
    expect(await api.loadBoard('login')).toEqual({ scene: 'login', notes: 'kept' });
    await expect(api.deleteBoard('login')).rejects.toThrow('Open another board');
    api.setMode('write');
    expect(mode).toHaveBeenCalledExactlyOnceWith('write');
  });
});
