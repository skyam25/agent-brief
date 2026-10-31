import { describe, expect, it } from 'vitest';
import { draftFile, draftKind, inWrite } from './drafts';

describe('draft kinds', () => {
  const review = { review: { path: 'site/index.html', comments: [] } };
  const outline = { outline: { path: 'docs/memo.outline.md' } };
  const sourced = { source: { path: 'docs/prd.md', text: '# PRD', sessionId: 's1' } };

  it('names what a draft is and whether Write shows it', () => {
    expect([review, outline, sourced, {}].map(draftKind)).toEqual(['review', 'outline', 'note', 'note']);
    expect([review, outline, sourced, {}].map(inWrite)).toEqual([false, true, true, true]);
  });

  it('names the project file a draft works on', () => {
    expect([review, outline, sourced, {}].map(draftFile)).toEqual(['site/index.html', 'docs/memo.outline.md', 'docs/prd.md', undefined]);
  });
});
