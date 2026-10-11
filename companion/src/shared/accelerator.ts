/** Checks an Electron accelerator such as `Control+Alt+S` and returns it in a canonical form. */

const MODIFIERS: Record<string, string> = {
  command: 'Command',
  cmd: 'Command',
  control: 'Control',
  ctrl: 'Control',
  commandorcontrol: 'CommandOrControl',
  cmdorctrl: 'CommandOrControl',
  alt: 'Alt',
  option: 'Option',
  altgr: 'AltGr',
  shift: 'Shift',
  super: 'Super',
  meta: 'Meta',
};

const NAMED_KEYS = [
  'Plus', 'Space', 'Tab', 'Capslock', 'Numlock', 'Scrolllock', 'Backspace', 'Delete', 'Insert', 'Return', 'Enter',
  'Up', 'Down', 'Left', 'Right', 'Home', 'End', 'PageUp', 'PageDown', 'Escape', 'Esc', 'PrintScreen',
  'VolumeUp', 'VolumeDown', 'VolumeMute', 'MediaNextTrack', 'MediaPreviousTrack', 'MediaStop', 'MediaPlayPause',
];

function canonicalKey(raw: string): string | undefined {
  if (/^[a-z0-9]$/i.test(raw)) return raw.toUpperCase();
  if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(raw)) return raw.toUpperCase();
  if (/^num([0-9]|dec|add|sub|mult|div)$/i.test(raw)) return `num${raw.slice(3).toLowerCase()}`;
  if (raw.length === 1 && /[)!@#$%^&*(:;:<_>?~{|}"'`,\-./=[\]\\]/.test(raw)) return raw;
  return NAMED_KEYS.find((k) => k.toLowerCase() === raw.toLowerCase());
}

export function parseAccelerator(input: string): { ok: true; value: string } | { ok: false; error: string } {
  const parts = input.split('+').map((p) => p.trim());
  if (input.trim() === '' || parts.some((p) => p === '')) return { ok: false, error: 'Type a shortcut such as Control+Alt+S' };
  const key = parts.pop()!;
  const mods: string[] = [];
  for (const p of parts) {
    const m = MODIFIERS[p.toLowerCase()];
    if (!m) return { ok: false, error: `${p} is not a modifier` };
    if (mods.includes(m)) return { ok: false, error: `${m} appears twice` };
    mods.push(m);
  }
  const canonical = canonicalKey(key);
  if (!canonical) return { ok: false, error: `${key} is not a key` };
  if (mods.length === 0 && !/^F\d+$/.test(canonical)) {
    return { ok: false, error: 'A global shortcut needs a modifier such as Control or Alt' };
  }
  return { ok: true, value: [...mods, canonical].join('+') };
}

const SYMBOLS: Record<string, string> = {
  Command: '⌘',
  Control: '⌃',
  CommandOrControl: '⌘',
  Alt: '⌥',
  Option: '⌥',
  Shift: '⇧',
};

/** `Control+Alt+S` as macOS writes it: `⌃⌥S`. */
export function acceleratorLabel(accelerator: string): string {
  const parts = accelerator.split('+');
  const key = parts.pop() ?? '';
  return parts.map((p) => SYMBOLS[p] ?? `${p}+`).join('') + (key === 'Space' ? 'Space' : key);
}

const CODE_KEYS: Record<string, string> = {
  Space: 'Space',
  Enter: 'Return',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
};

/** The key a press names, read from its physical code so ⌥ never turns S into ß. */
function keyOf(code: string): string | undefined {
  const letter = /^Key([A-Z])$/.exec(code)?.[1];
  if (letter) return letter;
  const digit = /^Digit(\d)$/.exec(code)?.[1];
  if (digit) return digit;
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  return CODE_KEYS[code];
}

export interface KeyPress {
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

/**
 * The accelerator a key press makes, such as `Control+Alt+S`. Undefined while
 * only modifiers are down, or for a key a global shortcut cannot use.
 */
export function acceleratorFromPress(e: KeyPress): string | undefined {
  const key = keyOf(e.code);
  if (!key) return undefined;
  const mods = [e.ctrlKey && 'Control', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Command'].filter(Boolean);
  return [...mods, key].join('+');
}
