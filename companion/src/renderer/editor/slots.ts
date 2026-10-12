/** Marks `{{slots}}` in the editor. Tab and ⇧Tab select the next and previous one. */

import { Extension, type Editor } from '@tiptap/core';
import type { Node as PmNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { findSlots } from '../../shared/slots';

export interface SlotRange {
  from: number;
  to: number;
}

/** Every slot in the document, in order. A slot lives inside one text run. */
export function slotRanges(doc: PmNode): SlotRange[] {
  const out: SlotRange[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    for (const s of findSlots(node.text)) out.push({ from: pos + s.start, to: pos + s.end });
  });
  return out;
}

/** Selects the slot after the selection, or before it going back. Wraps around. */
export function selectSlot(editor: Editor, back: boolean, from?: number): boolean {
  const slots = slotRanges(editor.state.doc);
  if (slots.length === 0) return false;
  const sel = editor.state.selection;
  const slot =
    from !== undefined
      ? (slots.find((s) => s.from >= from) ?? slots[0]!)
      : back
        ? ([...slots].reverse().find((s) => s.to < sel.from) ?? slots[slots.length - 1]!)
        : (slots.find((s) => s.from >= sel.to) ?? slots[0]!);
  editor.chain().focus().setTextSelection(slot).scrollIntoView().run();
  return true;
}

const key = new PluginKey<DecorationSet>('slots');

const decorate = (doc: PmNode) =>
  DecorationSet.create(
    doc,
    slotRanges(doc).map((s) => Decoration.inline(s.from, s.to, { nodeName: 'mark', class: 'slot' })),
  );

/** `skip` says when Tab belongs to someone else, such as an open menu. */
export const Slots = Extension.create<{ skip: () => boolean }>({
  name: 'slots',
  priority: 200,

  addOptions() {
    return { skip: () => false };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key,
        state: {
          init: (_, state) => decorate(state.doc),
          apply: (tr, old) => (tr.docChanged ? decorate(tr.doc) : old),
        },
        props: {
          decorations: (state) => key.getState(state),
        },
      }),
    ];
  },

  addKeyboardShortcuts() {
    const jump = (back: boolean) => {
      if (this.options.skip() || this.editor.isActive('table')) return false;
      return selectSlot(this.editor, back);
    };
    return {
      Tab: () => jump(false),
      'Shift-Tab': () => jump(true),
    };
  },
});
