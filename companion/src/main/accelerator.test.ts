import { describe, expect, it } from 'vitest';
import { acceleratorLabel, parseAccelerator } from './accelerator';

describe('parseAccelerator', () => {
  it('canonicalises modifiers and keys', () => {
    expect(parseAccelerator('ctrl+alt+s')).toEqual({ ok: true, value: 'Control+Alt+S' });
    expect(parseAccelerator('CmdOrCtrl + Shift + space')).toEqual({ ok: true, value: 'CommandOrControl+Shift+Space' });
    expect(parseAccelerator('F13')).toEqual({ ok: true, value: 'F13' });
  });

  it('rejects empty input, unknown parts, repeats and bare keys', () => {
    expect(parseAccelerator('').ok).toBe(false);
    expect(parseAccelerator('Control+')).toMatchObject({ ok: false });
    expect(parseAccelerator('Hyper+S')).toEqual({ ok: false, error: 'Hyper is not a modifier' });
    expect(parseAccelerator('Control+Banana')).toEqual({ ok: false, error: 'Banana is not a key' });
    expect(parseAccelerator('Alt+Alt+S')).toEqual({ ok: false, error: 'Alt appears twice' });
    expect(parseAccelerator('S')).toMatchObject({ ok: false, error: expect.stringMatching(/modifier/) });
  });
});

describe('acceleratorLabel', () => {
  it('writes shortcuts with macOS symbols', () => {
    expect(acceleratorLabel('Control+Alt+S')).toBe('⌃⌥S');
    expect(acceleratorLabel('CommandOrControl+Shift+Space')).toBe('⌘⇧Space');
  });
});
