import { IPC_INVOKE, IPC_SEND, type CompanionApi, type InvokeMethod, type SendMethod } from '../shared/ipc';

interface MainTransport {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown;
}

/** Main handlers use the same method names, arguments and results as the renderer API. */
export function mainIpc(transport: MainTransport) {
  return {
    handle<K extends InvokeMethod>(method: K, handler: (...args: Parameters<CompanionApi[K]>) => ReturnType<CompanionApi[K]> | Awaited<ReturnType<CompanionApi[K]>>) {
      transport.handle(IPC_INVOKE[method], (_event, ...args) => handler(...args as Parameters<CompanionApi[K]>));
    },
    on<K extends SendMethod>(method: K, handler: (...args: Parameters<CompanionApi[K]>) => void) {
      transport.on(IPC_SEND[method], (_event, ...args) => handler(...args as Parameters<CompanionApi[K]>));
    },
  };
}
