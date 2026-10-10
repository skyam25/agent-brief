import { describe, expect, it, vi } from 'vitest';
import { FakeRegistrar, Hotkey } from './hotkey';

describe('Hotkey', () => {
  it('registers, swaps, and keeps the old shortcut when the new one is taken', () => {
    const reg = new FakeRegistrar();
    const action = vi.fn();
    const hotkey = new Hotkey(reg, action);
    expect(hotkey.set('control+alt+s')).toEqual({ ok: true, hotkey: 'Control+Alt+S' });

    reg.taken.add('Command+Space');
    expect(hotkey.set('Command+Space')).toEqual({ ok: false, error: 'Command+Space is already used by another app or by macOS' });
    expect([...reg.registered.keys()]).toEqual(['Control+Alt+S']);

    expect(hotkey.set('Control+Shift+K')).toEqual({ ok: true, hotkey: 'Control+Shift+K' });
    expect([...reg.registered.keys()]).toEqual(['Control+Shift+K']);
    reg.registered.get('Control+Shift+K')!();
    expect(action).toHaveBeenCalledOnce();
  });

  it('reports malformed shortcuts without touching registration', () => {
    const reg = new FakeRegistrar();
    const hotkey = new Hotkey(reg, () => {});
    expect(hotkey.set('Control+Nope').ok).toBe(false);
    expect(reg.registered.size).toBe(0);
  });

  it('reports a registrar that throws', () => {
    const hotkey = new Hotkey({ register: () => { throw new Error('bad'); }, unregister: () => {} }, () => {});
    expect(hotkey.set('Control+Alt+S')).toEqual({ ok: false, error: 'Control+Alt+S is not a valid shortcut: bad' });
  });
});
