import { getSchema, type JSONContent } from '@tiptap/core';
import { EditorState } from '@tiptap/pm/state';
import { MarkdownManager } from '@tiptap/markdown';
import { describe, expect, it } from 'vitest';
import { formatForDepth, numberedListAt, setListFormat, stampDepthFormats } from './lists';
import { lightenEscapes, schemaExtensions } from './markdown';

const manager = () => {
  const m = new MarkdownManager({ extensions: schemaExtensions() });
  lightenEscapes(m);
  return m;
};
const schema = getSchema(schemaExtensions());
const stateOf = (doc: JSONContent) => EditorState.create({ schema, doc: schema.nodeFromJSON(doc) });
const markdownOf = (state: EditorState) => manager().serialize(state.doc.toJSON()).trim();

const item = (text: string, ...rest: JSONContent[]): JSONContent => ({
  type: 'listItem',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }, ...rest],
});
const list = (...items: JSONContent[]): JSONContent => ({ type: 'orderedList', content: items });

/** Three levels of lists with no format, as Tab makes them. */
const untyped = {
  type: 'doc',
  content: [list(item('one', list(item('two', list(item('three', list(item('four'))))))))],
};

describe('list formats', () => {
  it('cycles numbers, letters and roman numerals by depth', () => {
    expect([0, 1, 2, 3, 4].map(formatForDepth)).toEqual(['1', 'a', 'i', '1', 'a']);
  });

  it('gives nested lists their depth format and leaves the top list alone', () => {
    const state = stateOf(untyped);
    const next = state.apply(stampDepthFormats(state)!);
    const types: unknown[] = [];
    next.doc.descendants((n) => void (n.type.name === 'orderedList' && types.push(n.attrs.type)));
    expect(types).toEqual([null, 'a', 'i', '1']);
    expect(markdownOf(next)).toBe(['1. one', '   a. two', '      i. three', '         1. four'].join('\n'));
    expect(stampDepthFormats(next)).toBeNull();
  });

  it('keeps each format through the Markdown', () => {
    for (const md of ['1. one\n   a. two\n      i. three', '1. one\n   1. two', 'a. one\nb. two', 'i. one\nii. two']) {
      const m = manager();
      expect(m.serialize(m.parse(md)).trim()).toBe(md);
    }
  });

  it('reads nested digits as a choice, so the depth default does not replace them', () => {
    const state = stateOf(manager().parse('1. one\n   1. two'));
    expect(stampDepthFormats(state)).toBeNull();
  });

  it('changes the format of the list around a position', () => {
    const state = stateOf(manager().parse('1. one\n   a. two'));
    let inner = 0;
    state.doc.descendants((n, pos) => void (n.text === 'two' && (inner = pos)));
    const hit = numberedListAt(state, inner)!;
    expect(hit.format).toBe('a');
    const next = state.apply(setListFormat(state, hit.pos, 'i'));
    expect(markdownOf(next)).toBe('1. one\n   i. two');
    expect(numberedListAt(next, inner)!.format).toBe('i');
  });

  it('folds capital letters and numerals into their lowercase formats', () => {
    const state = stateOf(manager().parse('A. one\nB. two'));
    expect(numberedListAt(state, 3)!.format).toBe('a');
  });
});
