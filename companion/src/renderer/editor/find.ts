/** Find in the open note. Highlights every match of a query and steps through them. */

import { Extension } from '@tiptap/core';
import type { Node as PmNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { indexText } from './annotations';

export interface FindRange {
  from: number;
  to: number;
}

export interface FindState {
  query: string;
  matches: FindRange[];
  /** Index of the match in focus. -1 when there is none. */
  current: number;
}

/** A new query, searched from `from`, or a step to the next or previous match. */
export type FindMeta = { query: string; from?: number } | { step: 1 | -1 };

export const findKey = new PluginKey<FindState & { decorations: DecorationSet }>('find');

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Every match of `query`, ignoring case. Matches stay within one block. */
export function findMatches(doc: PmNode, query: string): FindRange[] {
  if (!query) return [];
  const { text, pos } = indexText(doc);
  const out: FindRange[] = [];
  for (const m of text.matchAll(new RegExp(escape(query), 'gi'))) {
    const end = m.index + m[0].length - 1;
    if (text.slice(m.index, end + 1).includes('\n')) continue;
    out.push({ from: pos[m.index]!, to: pos[end]! + 1 });
  }
  return out;
}

export function findState(state: EditorState): FindState {
  const s = findKey.getState(state);
  return s ? { query: s.query, matches: s.matches, current: s.current } : { query: '', matches: [], current: -1 };
}

function decorate(doc: PmNode, matches: FindRange[], current: number): DecorationSet {
  return DecorationSet.create(
    doc,
    matches.map((m, i) => Decoration.inline(m.from, m.to, { class: i === current ? 'find-hit current' : 'find-hit' })),
  );
}

export const Find = Extension.create({
  name: 'find',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: findKey,
        state: {
          init: (_, state) => ({ query: '', matches: [] as FindRange[], current: -1, decorations: DecorationSet.create(state.doc, []) }),
          apply: (tr, old) => {
            const meta = tr.getMeta(findKey) as FindMeta | undefined;
            let { query, matches, current } = old;
            if (meta && 'query' in meta) {
              query = meta.query;
              matches = findMatches(tr.doc, query);
              const from = meta.from ?? 0;
              current = matches.length ? Math.max(0, matches.findIndex((m) => m.to > from)) : -1;
            } else if (meta && matches.length) {
              current = (current + meta.step + matches.length) % matches.length;
            } else if (tr.docChanged && query) {
              matches = findMatches(tr.doc, query);
              current = matches.length ? Math.min(Math.max(current, 0), matches.length - 1) : -1;
            } else {
              return old;
            }
            return { query, matches, current, decorations: decorate(tr.doc, matches, current) };
          },
        },
        props: {
          decorations: (state) => findKey.getState(state)?.decorations,
        },
      }),
    ];
  },
});
