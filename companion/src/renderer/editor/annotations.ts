/**
 * Highlights the passages a note's comments quote. A comment stores its words, not
 * positions, so the Markdown stays clean and a highlight follows the text through edits.
 */

import { Extension } from '@tiptap/core';
import type { Node as PmNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { NoteComment } from '../../shared/annotations';

/** A selected passage, as a new comment records it. */
export interface Passage {
  quote: string;
  occurrence: number;
  heading?: string;
}

/** The note's text with a document position for each character. Blocks are joined with a newline. */
export interface TextIndex {
  text: string;
  pos: number[];
}

export function indexText(doc: PmNode): TextIndex {
  let text = '';
  const pos: number[] = [];
  let blocks = 0;
  doc.descendants((node, at) => {
    if (node.isTextblock && blocks++ > 0) {
      text += '\n';
      pos.push(at);
    }
    if (node.isText && node.text) {
      for (let i = 0; i < node.text.length; i++) pos.push(at + i);
      text += node.text;
    }
    return true;
  });
  return { text, pos };
}

/** Start offsets of every match of `quote`, overlapping ones included. */
function matches(text: string, quote: string): number[] {
  const out: number[] = [];
  for (let at = text.indexOf(quote); at !== -1; at = text.indexOf(quote, at + 1)) out.push(at);
  return out;
}

/** The text of the nearest heading above `pos`. */
function headingAbove(doc: PmNode, pos: number): string | undefined {
  let heading: string | undefined;
  doc.nodesBetween(0, pos, (node) => {
    if (node.type.name === 'heading') heading = node.textContent.trim() || heading;
    return !node.isTextblock;
  });
  return heading;
}

/** The passage between two positions, trimmed, with which match of its words it is. */
export function passageAt(doc: PmNode, from: number, to: number): Passage | undefined {
  const { text, pos } = indexText(doc);
  let a = pos.findIndex((p) => p >= from);
  let b = pos.findIndex((p) => p >= to);
  if (a === -1) return undefined;
  if (b === -1) b = pos.length;
  while (a < b && /\s/.test(text[a]!)) a++;
  while (b > a && /\s/.test(text[b - 1]!)) b--;
  if (a >= b) return undefined;
  const quote = text.slice(a, b);
  const occurrence = matches(text, quote).filter((m) => m < a).length;
  const heading = headingAbove(doc, from);
  return { quote, occurrence, ...(heading ? { heading } : {}) };
}

/** Where a comment's passage sits now: its match, or the first one when the earlier ones went. */
export function passageRange(doc: PmNode, quote: string, occurrence: number, index = indexText(doc)): { from: number; to: number } | undefined {
  const found = matches(index.text, quote);
  const start = found[occurrence] ?? found[0];
  if (start === undefined) return undefined;
  return { from: index.pos[start]!, to: index.pos[start + quote.length - 1]! + 1 };
}

export interface AnnotationsOptions {
  /** The comments to highlight and the one in focus. */
  get: () => { comments: NoteComment[]; activeId?: string };
  onClick: (id: string) => void;
  /** Ids whose passage is no longer in the note. */
  onMissing: (ids: string[]) => void;
  /** True while a finished selection should become a comment at once. */
  annotating: () => boolean;
  onSelect: (passage: Passage) => void;
}

export const annotationsKey = new PluginKey<DecorationSet>('annotations');

export const Annotations = Extension.create<AnnotationsOptions>({
  name: 'annotations',

  addOptions() {
    return { get: () => ({ comments: [] }), onClick: () => {}, onMissing: () => {}, annotating: () => false, onSelect: () => {} };
  },

  addProseMirrorPlugins() {
    const options = this.options;
    let missing = '';
    const decorate = (doc: PmNode) => {
      const { comments, activeId } = options.get();
      const index = indexText(doc);
      const decorations: Decoration[] = [];
      const gone: string[] = [];
      comments.forEach((c, i) => {
        const range = passageRange(doc, c.quote, c.occurrence, index);
        if (!range) {
          gone.push(c.id);
          return;
        }
        const active = c.id === activeId;
        decorations.push(
          Decoration.inline(range.from, range.to, { class: active ? 'annot active' : 'annot', 'data-annot': c.id }),
          Decoration.widget(
            range.to,
            () => {
              const badge = document.createElement('sup');
              badge.className = active ? 'annot-badge active' : 'annot-badge';
              badge.dataset.annot = c.id;
              badge.textContent = String(i + 1);
              return badge;
            },
            { side: 1, key: `annot-${c.id}-${i}-${active ? 1 : 0}`, ignoreSelection: true },
          ),
        );
      });

      // Reported after the transaction, since the owner sets React state.
      const key = gone.join(',');
      if (key !== missing) {
        missing = key;
        queueMicrotask(() => options.onMissing(gone));
      }
      return DecorationSet.create(doc, decorations);
    };

    return [
      new Plugin({
        key: annotationsKey,
        state: {
          init: (_, state) => decorate(state.doc),
          apply: (tr, old) => (tr.docChanged || tr.getMeta(annotationsKey) ? decorate(tr.doc) : old),
        },
        props: {
          decorations: (state) => annotationsKey.getState(state),
          handleDOMEvents: {
            mousedown: (_view, event) => {
              const hit = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-annot]');
              if (!hit?.dataset.annot) return false;
              options.onClick(hit.dataset.annot);
              return false;
            },
            mouseup: (view) => {
              if (!options.annotating()) return false;

              // The selection settles after mouseup.
              setTimeout(() => {
                const { from, to, empty } = view.state.selection;
                if (empty) return;
                const passage = passageAt(view.state.doc, from, to);
                if (!passage) return;
                view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, to)));
                options.onSelect(passage);
              });
              return false;
            },
          },
        },
      }),
    ];
  },
});
