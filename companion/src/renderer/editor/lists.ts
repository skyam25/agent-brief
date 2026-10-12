/**
 * Numbered lists. A nested list takes 1, a or i by depth, as in Notion, and
 * any list can pick its own format. The format is the list's `type`, which
 * the Markdown keeps as its markers.
 */

import { Extension, type JSONContent } from '@tiptap/core';
import { OrderedList } from '@tiptap/extension-list';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state';

export type ListFormat = '1' | 'a' | 'i';

export const LIST_FORMATS: { format: ListFormat; label: string; sample: string }[] = [
  { format: '1', label: 'Numbers', sample: '1.' },
  { format: 'a', label: 'Letters', sample: 'a.' },
  { format: 'i', label: 'Roman numerals', sample: 'i.' },
];

const CYCLE: ListFormat[] = ['1', 'a', 'i'];

/** The format for a list inside `depth` other numbered lists. */
export const formatForDepth = (depth: number): ListFormat => CYCLE[depth % CYCLE.length]!;

/** The list's format, with `A` and `I` folded into their lowercase forms. */
export function listFormat(node: PMNode, depth: number): ListFormat {
  const type = (node.attrs.type as string | null)?.toLowerCase();
  return CYCLE.includes(type as ListFormat) ? (type as ListFormat) : formatForDepth(depth);
}

/** How many numbered lists hold the node that starts at `pos`. */
function numberedDepth(state: EditorState, pos: number): number {
  const $pos = state.doc.resolve(pos);
  let depth = 0;
  for (let d = 1; d <= $pos.depth; d++) if ($pos.node(d).type.name === 'orderedList') depth++;
  return depth;
}

export interface NumberedListHit {
  pos: number;
  node: PMNode;
  format: ListFormat;
}

/** The innermost numbered list around `pos`. */
export function numberedListAt(state: EditorState, pos: number): NumberedListHit | undefined {
  const $pos = state.doc.resolve(pos);
  for (let d = $pos.depth; d > 0; d--) {
    const node = $pos.node(d);
    if (node.type.name !== 'orderedList') continue;
    const at = $pos.before(d);
    return { pos: at, node, format: listFormat(node, numberedDepth(state, at)) };
  }
  return undefined;
}

export function setListFormat(state: EditorState, pos: number, format: ListFormat): Transaction {
  return state.tr.setNodeAttribute(pos, 'type', format);
}

/** Gives each nested list without a format the one for its depth, so the Markdown matches what shows. */
export function stampDepthFormats(state: EditorState): Transaction | null {
  let tr: Transaction | null = null;
  state.doc.descendants((node, pos) => {
    if (node.type.name !== 'orderedList' || node.attrs.type) return;
    const depth = numberedDepth(state, pos);
    if (depth === 0) return;
    tr ??= state.tr;
    tr.setNodeAttribute(pos, 'type', formatForDepth(depth));
  });
  return tr;
}

/** Digits are a format too, so a nested `1.` in the Markdown stays numbers. */
export const NumberedList = OrderedList.extend({
  parseMarkdown(token, helpers) {
    const parsed = this.parent!(token, helpers) as JSONContent | JSONContent[];
    if (Array.isArray(parsed) || parsed.attrs?.type) return parsed;
    return { ...parsed, attrs: { ...parsed.attrs, type: '1' } };
  },
});

export const ListDepthFormats = Extension.create({
  name: 'listDepthFormats',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('listDepthFormats'),
        appendTransaction: (trs, _old, state) => (trs.some((t) => t.docChanged) ? stampDepthFormats(state) : null),
      }),
    ];
  },
});
