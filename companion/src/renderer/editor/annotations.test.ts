import { getSchema } from '@tiptap/core';
import { MarkdownManager } from '@tiptap/markdown';
import { describe, expect, it } from 'vitest';
import { passageAt, passageRange } from './annotations';
import { schemaExtensions } from './markdown';

const schema = getSchema(schemaExtensions());
const docOf = (markdown: string) => schema.nodeFromJSON(new MarkdownManager({ extensions: schemaExtensions() }).parse(markdown));

/** The positions of the `n`th match of `words`, found through the document's text. */
function rangeOf(doc: ReturnType<typeof docOf>, words: string, n = 0) {
  const hits: number[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText) return;
    for (let at = node.text!.indexOf(words); at !== -1; at = node.text!.indexOf(words, at + 1)) hits.push(pos + at);
  });
  return { from: hits[n]!, to: hits[n]! + words.length };
}

describe('note passages', () => {
  const doc = docOf('# Recap\n\n## Block 1\n\nAsk about **the metric**.\n\nAsk about the team.\n\n## Block 2\n\nAsk about the team.');

  it('records the words, the heading above and which match they are', () => {
    const r = rangeOf(doc, 'Ask about the team.', 1);
    expect(passageAt(doc, r.from, r.to)).toEqual({ quote: 'Ask about the team.', occurrence: 1, heading: 'Block 2' });
  });

  it('reads across marks and blocks, and trims the edges', () => {
    const from = rangeOf(doc, 'Ask about ').from;
    const to = rangeOf(doc, 'Ask about the team.').to;
    expect(passageAt(doc, from - 1, to + 1)?.quote).toBe('Ask about the metric.\nAsk about the team.');
  });

  it('finds a passage again by its words and match', () => {
    const r = rangeOf(doc, 'Ask about the team.', 1);
    expect(passageRange(doc, 'Ask about the team.', 1)).toEqual(r);
    expect(passageRange(doc, 'Ask about the team.', 5), 'a missing match falls back to the first').toEqual(rangeOf(doc, 'Ask about the team.'));
    expect(passageRange(doc, 'Not in the note', 0)).toBeUndefined();
  });

  it('answers nothing for a selection of blank space', () => {
    const r = rangeOf(doc, 'Recap');
    expect(passageAt(doc, r.to, r.to)).toBeUndefined();
  });
});
