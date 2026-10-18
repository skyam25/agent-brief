import { CH, IPC_EVENT, IPC_INVOKE, IPC_SEND, type BoardReply, type BoardRequest, type CompanionApi, type NewNote, type OpenDraft } from '../shared/ipc';

interface RendererTransport {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  send(channel: string, ...args: unknown[]): void;
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown;
  removeListener(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown;
}

/** Builds only the allowlisted methods, strips Electron events, and owns listener cleanup. */
export function createPreloadApi(transport: RendererTransport): CompanionApi {
  const subscribe = (channel: string, callback: (...args: unknown[]) => void) => {
    const listener = (_event: unknown, ...args: unknown[]) => callback(...args);
    transport.on(channel, listener);
    return () => { transport.removeListener(channel, listener); };
  };
  const methods: Record<string, unknown> = {};
  for (const [method, channel] of Object.entries(IPC_INVOKE)) {
    methods[method] = (...args: unknown[]) => transport.invoke(channel, ...args);
  }
  for (const [method, channel] of Object.entries(IPC_SEND)) {
    methods[method] = (...args: unknown[]) => transport.send(channel, ...args);
  }
  for (const [method, channel] of Object.entries(IPC_EVENT)) {
    methods[method] = (callback: (...args: unknown[]) => void) => subscribe(channel, callback);
  }
  // Compatibility with older main-process events remains at the transport boundary.
  methods.onNewNote = (callback: (note: NewNote) => void) => subscribe(CH.newNote, (note) => callback((note as NewNote) ?? {}));
  methods.onOpenDraft = (callback: (open: OpenDraft) => void) => subscribe(CH.openDraft, (open) => callback(typeof open === 'string' ? { id: open } : open as OpenDraft));
  methods.onRequest = (handler: (req: BoardRequest) => Promise<BoardReply>) => subscribe(CH.request, (req) => {
    void handler(req as BoardRequest).then((reply) => transport.send(CH.reply, reply));
  });
  // Mapped contracts above enforce API completeness; this cast bridges the runtime object construction.
  return methods as unknown as CompanionApi;
}
