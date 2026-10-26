import { describe, expect, it } from 'vitest';
import { acceptDirectionPrompt, askPrompt, generatePrompt, outlineFeedbackAsk } from './outline-prompts';

const doc = { path: 'docs/memo.outline.md', target: 'docs/memo.md', kind: 'document' as const, sections: [{ id: 's1', title: 'Why now', points: [] }] };
const untargeted = { ...doc, target: undefined, kind: 'page' as const };

describe('outline prompts', () => {
  it('generates the target, or asks Claude to pick one', () => {
    expect(generatePrompt(doc)).toBe('Generate docs/memo.md from docs/memo.outline.md (outline-first). Read each source and mark its cites, write it fresh from the outline, then check it against the outline.');
    expect(generatePrompt(untargeted)).toBe('Generate the page from docs/memo.outline.md (outline-first). Read each source and mark its cites, pick a target path beside the outline, set it with setMeta, write it, then check it against the outline.');
  });

  it('asks about a section or the whole outline', () => {
    expect(askPrompt(doc, 's1', ' Add a point on churn ')).toBe('On docs/memo.outline.md (outline-first), section "Why now" (s1): Add a point on churn\nUpdate the outline only, through agent-brief outline apply. Do not write docs/memo.md.');
    expect(askPrompt(untargeted, undefined, 'Tighten it')).toBe('On docs/memo.outline.md (outline-first): Tighten it\nUpdate the outline only, through agent-brief outline apply. Do not write the target.');
    expect(askPrompt(doc, 's9', 'x')).toMatch(/^On docs\/memo.outline.md \(outline-first\): x\n/);
  });

  it('accepts a direction at a scope', () => {
    expect(acceptDirectionPrompt(doc, 'sections')).toBe('Direction accepted for docs/memo.outline.md (outline-first). Revise docs/memo.md at scope sections from the updated outline, check it against the outline, then clear the direction.');
    expect(acceptDirectionPrompt(untargeted, 'edit')).toContain('Revise the page at scope edit');
  });

  it('routes comments on a target through its outline', () => {
    expect(outlineFeedbackAsk('docs/memo.md', 'docs/memo.outline.md', '3 comments')).toBe(
      'Comments on docs/memo.md from Agent Brief, 3 comments. docs/memo.md has an outline at docs/memo.outline.md (outline-first). Do not change docs/memo.md yet. Read the comments together, update the outline, and propose a direction with setDirection. The user accepts it in Agent Brief.',
    );
  });
});
