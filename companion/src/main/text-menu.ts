/** The right-click menu for text. Electron shows none of its own, so spelling fixes and Cut, Copy and Paste live here. */

import type { ContextMenuParams, MenuItemConstructorOptions } from 'electron';

const MOST_GUESSES = 5;

export type TextMenuParams = Pick<ContextMenuParams, 'isEditable' | 'misspelledWord' | 'dictionarySuggestions' | 'selectionText' | 'editFlags'>;

export interface SpellingActions {
  replace: (word: string) => void;
  learn: (word: string) => void;
}

/** Spelling guesses for a misspelled word, then the edit actions. Empty when the click is on nothing to edit or copy. */
export function textMenuTemplate(p: TextMenuParams, a: SpellingActions): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = [];
  if (p.isEditable && p.misspelledWord) {
    const guesses = p.dictionarySuggestions.slice(0, MOST_GUESSES);
    if (guesses.length === 0) items.push({ label: 'No Guesses Found', enabled: false });
    for (const guess of guesses) items.push({ label: guess, click: () => a.replace(guess) });
    items.push({ type: 'separator' }, { label: 'Learn Spelling', click: () => a.learn(p.misspelledWord) }, { type: 'separator' });
  }
  if (p.isEditable) {
    items.push(
      { role: 'cut', enabled: p.editFlags.canCut },
      { role: 'copy', enabled: p.editFlags.canCopy },
      { role: 'paste', enabled: p.editFlags.canPaste },
      { type: 'separator' },
      { role: 'selectAll' },
    );
  } else if (p.selectionText.trim()) {
    items.push({ role: 'copy' });
  }
  return items;
}
