/** Find in the open note, over the editor. */

import type { Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import { useEffect, useRef, useState } from 'react';
import { FindField, type FindCount } from '../FindField';
import { findKey, findState, type FindMeta } from './find';

/** Searches the note, or steps through its matches, and brings the match in focus into view. */
export function findIn(editor: Editor, meta: FindMeta): void {
  editor.view.dispatch(editor.state.tr.setMeta(findKey, meta));
  const hit = editor.view.dom.querySelector<HTMLElement>('.find-hit.current');
  const scroller = hit?.closest<HTMLElement>('.rich-editor');
  if (!hit || !scroller) return;
  const box = hit.getBoundingClientRect();
  const view = scroller.getBoundingClientRect();
  if (box.top < view.top || box.bottom > view.bottom) hit.scrollIntoView({ block: 'center' });
}

export function FindBar(props: {
  editor: Editor;
  /** The query to start with. A new `seedKey` puts it in again and takes focus. */
  seed: string;
  seedKey: number;
  onClose: () => void;
}) {
  const { editor } = props;
  const input = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(props.seed);
  const [count, setCount] = useState<FindCount>({ total: 0, current: -1 });

  // The count follows edits to the note as well as the bar's own searches.
  useEffect(() => {
    const read = () => {
      const s = findState(editor.state);
      setCount({ total: s.matches.length, current: s.current });
    };
    editor.on('transaction', read);
    return () => {
      editor.off('transaction', read);
    };
  }, [editor]);

  useEffect(() => {
    setValue(props.seed);
    findIn(editor, { query: props.seed, from: editor.state.selection.from });
    input.current?.focus();
    input.current?.select();
  }, [props.seedKey]);

  /** Clears the highlights and puts the cursor on the match in focus. */
  const close = () => {
    const { matches, current } = findState(editor.state);
    const hit = matches[current];
    editor.view.dispatch(editor.state.tr.setMeta(findKey, { query: '' } satisfies FindMeta));
    if (hit) editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, hit.from, hit.to)));
    editor.view.focus();
    props.onClose();
  };

  return (
    <FindField
      label="Find in note"
      value={value}
      count={count}
      inputRef={input}
      onChange={(next) => {
        setValue(next);
        findIn(editor, { query: next, from: editor.state.selection.from });
      }}
      onStep={(dir) => findIn(editor, { step: dir })}
      onClose={close}
    />
  );
}
