/** Panel shortcuts: ⌃Tab and ⌃1–9 switch tabs, ⌘1–4 switch modes, ⌥T talks, and Escape closes what is open, then hides. */

import { useEffect, useRef } from 'react';
import type { Mode } from '../shared/ipc';
import { talkOwner } from './talk-owner';

export interface PanelKeys {
  /** Session tab ids, in order. Notes comes before them. */
  tabs: string[];
  activeBrief: string | undefined;
  switchBrief: (sessionId: string) => void;
  openNotes: () => void;
  changeMode: (mode: Mode) => void;
  /** Starts or stops the mic. Undefined where the mode has none. */
  onTalk?: () => void;
  popoverOpen: boolean;
  closePopovers: () => void;
  /** Escape that nothing on the panel claimed. */
  onEscape: () => void;
}

const BY_KEY: Record<string, Mode> = { '1': 'sketch', '2': 'write', '3': 'review', '4': 'initiative' };

/** Listens once. `keys` is read at each press, so it may change every render. */
export function usePanelKeys(keys: PanelKeys): void {
  const latest = useRef(keys);
  latest.current = keys;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = latest.current;
      // A shortcut field in Settings takes every key while it records.
      if (document.querySelector('.key-chip.recording')) return;
      if (e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'Tab' || /^[1-9]$/.test(e.key))) {
        if (k.tabs.length === 0) return;
        e.preventDefault();
        // Notes is the first tab, then each session's.
        const order = [undefined, ...k.tabs];
        const at = order.indexOf(k.activeBrief);
        const index = e.key === 'Tab' ? (at + (e.shiftKey ? -1 : 1) + order.length) % order.length : Number(e.key) - 1;
        if (index >= order.length || index === at) return;
        const next = order[index];
        if (next) k.switchBrief(next);
        else k.openNotes();
        return;
      }
      if (e.metaKey && !e.shiftKey && !e.altKey && BY_KEY[e.key]) {
        e.preventDefault();
        // Review needs a session tab.
        if (BY_KEY[e.key] === 'review' && !k.activeBrief) return;
        k.changeMode(BY_KEY[e.key]!);
        return;
      }
      // By code, since ⌥T types † as a key.
      // A view with its own mic, such as a feedback workspace, takes it first.
      const talk = talkOwner() ?? k.onTalk;
      if (e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey && e.code === 'KeyT' && talk) {
        e.preventDefault();
        talk();
        return;
      }
      if (e.key !== 'Escape') return;
      // A menu inside the editor, such as the template picker, closes first.
      if (document.querySelector('[data-escape-owner]')) return;
      if (k.popoverOpen) {
        k.closePopovers();
        e.stopPropagation();
        return;
      }
      k.onEscape();
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, []);
}
