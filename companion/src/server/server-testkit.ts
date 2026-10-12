/** Server test setup: started servers close in `closeServers`, run from each file's afterEach. */

import { vi } from 'vitest';
import { SessionModes } from '../main/session-modes';
import type { BoardBackend } from './contract';
import { harness } from './testkit';

export const openServers: { close(): Promise<void> }[] = [];

export async function closeServers() {
  while (openServers.length) await openServers.pop()!.close();
}

export async function start<B extends Partial<BoardBackend>>(extra?: B) {
  const h = harness(extra);
  openServers.push(h.server);
  await h.server.listen();
  return h;
}

/** A server whose backend mirrors modes with the app's own store. */
export async function startModed() {
  const modes = new SessionModes();
  const tracked = new Map<string, boolean>();
  const h = await start({
    mode: vi.fn((id: string) => modes.get(id)),
    setMode: vi.fn((id: string, patch) => modes.set(id, patch)),
    tracking: (id: string) => (tracked.has(id) ? { trackItems: tracked.get(id)! } : undefined),
    setTracking: vi.fn((id: string, on: boolean) => void tracked.set(id, on)),
  } satisfies Partial<BoardBackend>);
  await h.call('POST', '/sessions', { sessionId: 'a', cwd: '/x' });
  return { ...h, modes };
}

/** A server whose backend keeps item tracking in a map, as the app does. */
export async function startTracked() {
  const tracked = new Map<string, boolean>();
  const h = await start({
    tracking: vi.fn((id: string) => (tracked.has(id) ? { trackItems: tracked.get(id)! } : undefined)),
    setTracking: vi.fn((id: string, on: boolean) => void tracked.set(id, on)),
  });
  return { ...h, tracked };
}
