/** Each live session's mode, mirrored from the mod. Kept in memory, so it ends with the session. */

import type { ModePatch } from '../protocol';

export class SessionModes {
  private readonly modes = new Map<string, ModePatch>();

  get(sessionId: string): ModePatch | undefined {
    return this.modes.get(sessionId);
  }

  /** Default mode clears the record. Only prototype keeps a fidelity. */
  set(sessionId: string, patch: ModePatch): void {
    if (patch.mode === 'default') {
      this.modes.delete(sessionId);
      return;
    }
    const fidelity = patch.mode === 'prototype' ? patch.fidelity : undefined;
    this.modes.set(sessionId, { mode: patch.mode, ...(fidelity ? { fidelity } : {}) });
  }

  /** Forgets every session not in `live`. */
  keepOnly(live: string[]): void {
    for (const id of this.modes.keys()) if (!live.includes(id)) this.modes.delete(id);
  }
}
