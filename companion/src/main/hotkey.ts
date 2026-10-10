/** The global show/hide shortcut. Changing it registers the new one before letting go of the old. */

import { parseAccelerator } from './accelerator';

export interface Registrar {
  register(accelerator: string, fn: () => void): boolean;
  unregister(accelerator: string): void;
}

export type HotkeyResult = { ok: true; hotkey: string } | { ok: false; error: string };

export class Hotkey {
  current?: string;

  constructor(
    private readonly registrar: Registrar,
    private readonly action: () => void,
  ) {}

  set(input: string): HotkeyResult {
    const parsed = parseAccelerator(input);
    if (!parsed.ok) return parsed;
    const next = parsed.value;
    if (next === this.current) return { ok: true, hotkey: next };
    let registered: boolean;
    try {
      registered = this.registrar.register(next, this.action);
    } catch (err) {
      return { ok: false, error: `${next} is not a valid shortcut: ${(err as Error).message}` };
    }
    if (!registered) return { ok: false, error: `${next} is already used by another app or by macOS` };
    if (this.current) this.registrar.unregister(this.current);
    this.current = next;
    return { ok: true, hotkey: next };
  }
}

/** A registrar that grabs nothing. Tests use it so they never take the user's keys. */
export class FakeRegistrar implements Registrar {
  readonly registered = new Map<string, () => void>();
  /** Accelerators that act as if another app owns them. */
  readonly taken = new Set<string>();

  register(accelerator: string, fn: () => void): boolean {
    if (this.taken.has(accelerator)) return false;
    this.registered.set(accelerator, fn);
    return true;
  }

  unregister(accelerator: string): void {
    this.registered.delete(accelerator);
  }
}
