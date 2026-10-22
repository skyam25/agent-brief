import { describe, expect, it, vi } from 'vitest';
import { textMenuTemplate, type TextMenuParams } from './text-menu';

const flags = { canCut: true, canCopy: true, canPaste: true } as TextMenuParams['editFlags'];
const params = (p: Partial<TextMenuParams>): TextMenuParams => ({
  isEditable: true,
  misspelledWord: '',
  dictionarySuggestions: [],
  selectionText: '',
  editFlags: flags,
  ...p,
});
const labels = (items: ReturnType<typeof textMenuTemplate>) => items.map((i) => i.label ?? i.role ?? i.type);

describe('text menu', () => {
  it('leads with spelling guesses that replace the word, then the edit actions', () => {
    const actions = { replace: vi.fn(), learn: vi.fn() };
    const items = textMenuTemplate(params({ misspelledWord: 'eligibilty', dictionarySuggestions: ['eligibility', 'a', 'b', 'c', 'd', 'e'] }), actions);
    expect(labels(items)).toEqual(['eligibility', 'a', 'b', 'c', 'd', 'separator', 'Learn Spelling', 'separator', 'cut', 'copy', 'paste', 'separator', 'selectAll']);
    (items[0]!.click as () => void)();
    expect(actions.replace).toHaveBeenCalledWith('eligibility');
    (items[6]!.click as () => void)();
    expect(actions.learn).toHaveBeenCalledWith('eligibilty');
  });

  it('says so when there are no guesses', () => {
    const items = textMenuTemplate(params({ misspelledWord: 'qzxv' }), { replace: vi.fn(), learn: vi.fn() });
    expect(items[0]).toMatchObject({ label: 'No Guesses Found', enabled: false });
  });

  it('follows the edit flags', () => {
    const items = textMenuTemplate(params({ editFlags: { ...flags, canCut: false, canCopy: false } }), { replace: vi.fn(), learn: vi.fn() });
    expect(items.slice(0, 3).map((i) => i.enabled)).toEqual([false, false, true]);
  });

  it('offers Copy for selected text outside a field, and nothing for a bare click', () => {
    const none = { replace: vi.fn(), learn: vi.fn() };
    expect(labels(textMenuTemplate(params({ isEditable: false, selectionText: 'some words' }), none))).toEqual(['copy']);
    expect(textMenuTemplate(params({ isEditable: false, selectionText: ' ' }), none)).toEqual([]);
  });
});
