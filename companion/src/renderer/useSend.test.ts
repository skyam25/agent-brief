import { expect, it, vi } from 'vitest';
import type { CompanionApi, Draft, Mode, SendResult } from '../shared/ipc';
import { BoardCommentsStore } from './board-comments';
import { DraftBook } from './drafts';
import { useSend, type SendDeps } from './useSend';

vi.mock('react', () => ({ useRef: (current: unknown) => ({ current }) }));
vi.mock('./editor/RichEditor', () => ({ focusFirstSlot() {} }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((done) => { resolve = done; }), resolve: (value: T) => resolve(value) };
}

function setup(mode: Mode = 'write') {
  const disk = new Map<string, Draft>();
  const host = {
    saveDraft: vi.fn(async (draft: Draft) => { disk.set(draft.id, draft); }),
    deleteDraft: vi.fn(async (id: string) => { disk.delete(id); }),
    listDrafts: async () => [...disk.values()],
    send: vi.fn(async (): Promise<SendResult> => ({ ok: true, message: 'Sent' })),
    setTarget: vi.fn(async (_id: string | undefined) => {}),
    hidePanel: vi.fn(),
  } as unknown as CompanionApi;
  const book = new DraftBook(host);
  const deps = {
    host, book, comments: new BoardCommentsStore(), controller: {}, items: {},
    reviewVoice: { stop: async () => {} }, modeRef: { current: mode },
    activeBrief: 'A', targetSessionId: 'A', notify: vi.fn(), setChooserOpen: vi.fn(),
  } as unknown as SendDeps;
  return { host, book, disk, deps, send: useSend(deps) };
}

it('does not deliver or consume the note when selecting the destination fails', async () => {
  const { host, book, send, deps } = setup();
  const draft = book.create('Keep this note');
  vi.mocked(host.setTarget).mockRejectedValueOnce(new Error('unknown session B'));
  await send.sendTo('B');
  expect(host.send).not.toHaveBeenCalled();
  expect(book.get(draft.id)?.body).toBe('Keep this note');
  expect(deps.notify).toHaveBeenLastCalledWith(expect.stringContaining('unknown session B'), 'error');
});

it('binds delivery to the chosen session and snapshots the note before retargeting', async () => {
  const { host, book, send } = setup();
  book.create('Unfiled note');
  vi.mocked(host.setTarget).mockImplementationOnce(async () => { book.select(undefined); });
  await send.sendTo('B');
  expect(host.send).toHaveBeenCalledWith(expect.objectContaining({ text: 'Unfiled note' }), 'B');
});

it('keeps the picked session as the target when the Send stops at a warning', async () => {
  const { host, send } = setup();
  await send.sendTo('B');
  expect(host.setTarget).toHaveBeenCalledWith('B');
  expect(host.send).not.toHaveBeenCalled();
});

it('uses the target from the Send click even if preparation takes time', async () => {
  const { host, book, send, deps } = setup();
  book.create('To A');
  const ready = deferred<void>();
  vi.spyOn(book, 'flush').mockImplementationOnce(() => ready.promise);
  const pending = send.send();
  deps.targetSessionId = 'B';
  ready.resolve();
  await pending;
  expect(host.send).toHaveBeenCalledWith(expect.objectContaining({ text: 'To A' }), 'A');
});

it('keeps and resaves a review pin added while delivery is pending', async () => {
  const { host, book, disk, send } = setup('review');
  const draft = book.create('Overall feedback', 'review', 'A', undefined, { path: 'page.html', comments: [] });
  const started = deferred<void>();
  const delivery = deferred<SendResult>();
  vi.mocked(host.send).mockImplementationOnce(async () => { started.resolve(); return delivery.promise; });
  const pending = send.send();
  await started.promise;
  book.addComment(draft.id, { id: 'later', text: 'New feedback', createdAt: 2, anchor: { selector: 'h1', tag: 'h1', fx: 0.5, fy: 0.5, rect: { x: 0, y: 0, width: 100, height: 20 }, scrollY: 0, viewport: { width: 800, height: 600 } } });
  disk.delete(draft.id); // The original send consumed the saved copy in main.
  delivery.resolve({ ok: true, message: 'Sent' });
  await pending;
  expect(book.get(draft.id)?.review?.comments[0].text).toBe('New feedback');
  expect(disk.get(draft.id)?.review?.comments[0].text).toBe('New feedback');
});
