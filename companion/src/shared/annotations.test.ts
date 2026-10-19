import { describe, expect, it } from 'vitest';
import { annotationsAsk, annotationsMarkdown, cleanAnnotations, hasAnnotations } from './annotations';

const comment = { id: 'n1', quote: 'Walk me through a product.', occurrence: 0, heading: 'Block 1', text: 'Ask for the metric.', createdAt: 1 };

describe('note annotations', () => {
  it('keeps known fields and drops comments without an id or a quote', () => {
    const clean = cleanAnnotations({
      comments: [comment, { id: 'bad id!', quote: 'x' }, { id: 'n2', quote: '  ' }, { ...comment, id: 'n3', occurrence: -2, extra: 1 }],
      overall: 'Shorter.',
      junk: true,
    });
    expect(clean).toEqual({ comments: [comment, { ...comment, id: 'n3', occurrence: 0 }], overall: 'Shorter.' });
    expect(cleanAnnotations({ comments: [] })).toBeUndefined();
    expect(cleanAnnotations('x')).toBeUndefined();
  });

  it('counts an overall comment alone as something to send', () => {
    expect(hasAnnotations({ comments: [], overall: 'Shorter.' })).toBe(true);
    expect(hasAnnotations({ comments: [], overall: '  ' })).toBe(false);
    expect(hasAnnotations(undefined)).toBe(false);
  });

  it('writes each passage with its comment, heading and repeat', () => {
    const md = annotationsMarkdown({ title: 'Recap', overall: 'Shorter.', comments: [comment, { ...comment, id: 'n2', occurrence: 1, text: '' }] }, 'b/draft.md');
    expect(md).toContain('# Comments on the note “Recap”');
    expect(md).toContain('The full text, with any edits, is in b/draft.md.');
    expect(md).toContain('## Overall\n\nShorter.');
    expect(md).toContain('## 1. “Walk me through a product.”\n\nAsk for the metric.\n\n- Under heading: “Block 1”');
    expect(md).toContain('## 2. “Walk me through a product.”\n\n(No words. The user highlighted this passage.)');
    expect(md).toContain('This is match 2.');
  });

  it('asks for a revised note, or for changes to the source file', () => {
    expect(annotationsAsk({ title: 'Recap', comments: [comment] })).toBe(
      'Comments on the note “Recap” from Agent Brief, 1 comment on passages. Revise the note to address them, save the new version with `agent-brief note "Recap"`, open it with the line that command prints, then say what changed.',
    );
    expect(annotationsAsk({ title: 'Recap', noteId: 'd7', comments: [comment] })).toBe(
      'Comments on the note “Recap” from Agent Brief, 1 comment on passages. Revise the note in place: run `agent-brief note --id d7` with the full new text, then `agent-brief open --note d7`, then say what changed.',
    );
    expect(annotationsAsk({ comments: [], overall: 'x' }, 'docs/plan.md')).toBe(
      'Comments on docs/plan.md from Agent Brief, an overall comment. Make the changes in docs/plan.md, keep what the comments do not touch, then say what changed.',
    );
  });
});
