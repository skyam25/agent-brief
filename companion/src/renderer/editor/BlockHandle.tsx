/**
 * Mouse paths to the `/` menu. A "+" sits in the gutter beside the hovered
 * block, or beside the empty line holding the cursor. An empty draft offers
 * its templates as chips.
 */

import type { Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { useEffect, useState, type RefObject } from 'react';
import type { Template } from '../../shared/ipc';
import { PlusIcon } from '../Icons';

/** The top-level block holding `pos`. */
export function topBlockAt(doc: PMNode, pos: number): { pos: number; node: PMNode } | undefined {
  if (doc.childCount === 0) return undefined;
  const $p = doc.resolve(Math.max(0, Math.min(pos, doc.content.size)));
  const index = Math.min($p.index(0), doc.childCount - 1);
  return { pos: $p.posAtIndex(index, 0), node: doc.child(index) };
}

/**
 * Re-renders once a frame after edits, focus or blur. Picture views render
 * with flushSync during a transaction, so a state update there must wait.
 */
function useEditorTick(editor: Editor): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    let frame = 0;
    const bump = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        setTick((n) => n + 1);
      });
    };
    editor.on('transaction', bump);
    editor.on('focus', bump);
    editor.on('blur', bump);
    return () => {
      cancelAnimationFrame(frame);
      editor.off('transaction', bump);
      editor.off('focus', bump);
      editor.off('blur', bump);
    };
  }, [editor]);
}

const isEmptyLine = (node: PMNode) => node.type.name === 'paragraph' && node.content.size === 0;

/** Where the "+" goes: the middle of the block's first line, relative to `box`. */
function lineMiddle(editor: Editor, block: { pos: number; node: PMNode }, box: DOMRect): number | undefined {
  let pos = block.pos;
  let node = block.node;
  while (!node.isTextblock && !node.isAtom && node.firstChild) {
    pos += 1;
    node = node.firstChild;
  }
  if (node.isTextblock) {
    const c = editor.view.coordsAtPos(pos + 1);
    return (c.top + c.bottom) / 2 - box.top;
  }
  const dom = editor.view.nodeDOM(block.pos);
  if (!(dom instanceof HTMLElement)) return undefined;
  const r = dom.getBoundingClientRect();
  return r.top + Math.min(r.height, 22) / 2 - box.top;
}

/**
 * Opens the `/` menu for a block. An empty line takes the slash itself.
 * Any other block gets a new line below it.
 */
export function openSlashAt(editor: Editor, block: { pos: number; node: PMNode }): void {
  if (isEmptyLine(block.node)) {
    editor.chain().focus().setTextSelection(block.pos + 1).insertContent('/').run();
    return;
  }
  const at = block.pos + block.node.nodeSize;
  editor
    .chain()
    .focus()
    .insertContentAt(at, { type: 'paragraph', content: [{ type: 'text', text: '/' }] })
    .setTextSelection(at + 2)
    .scrollIntoView()
    .run();
}

export function BlockHandle(props: { editor: Editor; box: RefObject<HTMLDivElement | null>; hidden: boolean }) {
  const { editor, box } = props;
  const [hover, setHover] = useState<number>();

  useEditorTick(editor);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onMove = (e: MouseEvent) => {
      const doc = editor.view.dom.getBoundingClientRect();

      // Probe just inside the text column, so the gutter counts as the block beside it.
      const hit = editor.view.posAtCoords({ left: doc.left + 40, top: e.clientY });
      const block = hit && topBlockAt(editor.state.doc, hit.inside >= 0 ? hit.inside : hit.pos);
      const dom = block && editor.view.nodeDOM(block.pos);

      // Below the last block, posAtCoords still answers. Only a block level with the pointer counts.
      const r = dom instanceof HTMLElement ? dom.getBoundingClientRect() : undefined;
      setHover(block && r && e.clientY >= r.top - 4 && e.clientY <= r.bottom + 4 ? block.pos : undefined);
    };
    const onLeave = () => setHover(undefined);
    el.addEventListener('mousemove', onMove);
    el.addEventListener('mouseleave', onLeave);
    return () => {
      el.removeEventListener('mousemove', onMove);
      el.removeEventListener('mouseleave', onLeave);
    };
  }, [editor, box]);

  if (props.hidden || !editor.isEditable || !box.current) return null;
  const { doc, selection } = editor.state;
  const caret = selection.empty && editor.isFocused ? topBlockAt(doc, selection.from) : undefined;
  const at = hover ?? (caret && isEmptyLine(caret.node) ? caret.pos : undefined);
  if (at === undefined || at >= doc.content.size) return null;
  const block = topBlockAt(doc, at);
  if (!block || block.pos !== at) return null;
  const top = lineMiddle(editor, block, box.current.getBoundingClientRect());
  if (top === undefined) return null;

  return (
    <button
      type="button"
      className="block-plus"
      style={{ top: top - 10 }}
      aria-label="Insert a block"
      title="Insert a block or template"
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => openSlashAt(editor, block)}
      data-testid="block-plus"
    >
      <PlusIcon />
    </button>
  );
}

/** Template chips under the placeholder of an empty draft. */
export function StarterChips(props: { editor: Editor; templates: Template[]; onPick: (t: Template) => void }) {
  useEditorTick(props.editor);
  const empty = props.editor.isEmpty;
  if (!empty || props.templates.length === 0) return null;
  return (
    <div className="starter-chips" data-testid="starter-chips">
      <span className="muted">Start from</span>
      {props.templates.slice(0, 4).map((t) => (
        <button
          key={t.id}
          type="button"
          className="starter-chip"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => props.onPick(t)}
          data-testid="starter-chip"
          data-id={t.id}
        >
          {t.title || 'Untitled template'}
        </button>
      ))}
    </div>
  );
}
