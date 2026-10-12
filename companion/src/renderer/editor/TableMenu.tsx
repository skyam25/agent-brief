/** Row, column and header controls that float over the table holding the cursor. */

import type { Editor } from '@tiptap/core';
import type { EditorState } from '@tiptap/pm/state';
import { BubbleMenu } from '@tiptap/react/menus';
import { useCallback, type ReactNode } from 'react';
import { TrashIcon } from '../Icons';
import { ColLeftIcon, ColRightIcon, HeaderRowIcon, RowAboveIcon, RowBelowIcon } from './icons';

const OPTIONS = { placement: 'top-end' as const, offset: 6, flip: true, shift: { padding: 8 } };

/** The document position of the table around the selection, if any. */
function tablePos(state: EditorState): number | undefined {
  const $from = state.selection.$from;
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type.name === 'table') return $from.before(d);
  }
  return undefined;
}

export function TableMenu(props: { editor: Editor }) {
  const { editor } = props;

  const shouldShow = useCallback(
    ({ editor: e, view }: { editor: Editor; view: Editor['view'] }) => e.isEditable && view.hasFocus() && e.isActive('table'),
    [],
  );

  /** Anchors the menu to the whole table, not the selection. */
  const reference = useCallback(() => {
    const pos = tablePos(editor.state);
    if (pos === undefined) return null;
    const dom = editor.view.nodeDOM(pos);
    if (!(dom instanceof HTMLElement)) return null;
    return { getBoundingClientRect: () => dom.getBoundingClientRect(), contextElement: dom };
  }, [editor]);

  const button = (testId: string, label: string, icon: ReactNode, run: () => boolean, danger = false) => (
    <button
      type="button"
      className={danger ? 'format-button danger' : 'format-button'}
      aria-label={label}
      title={label}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => run()}
      data-testid={testId}
    >
      {icon}
    </button>
  );
  const chain = () => editor.chain().focus();

  return (
    <BubbleMenu
      editor={editor}
      pluginKey="tableMenu"
      shouldShow={shouldShow}
      getReferencedVirtualElement={reference}
      options={OPTIONS}
      className="format-bar table-menu"
      data-testid="table-menu"
    >
      {button('table-row-above', 'Add a row above', <RowAboveIcon />, () => chain().addRowBefore().run())}
      {button('table-row-below', 'Add a row below', <RowBelowIcon />, () => chain().addRowAfter().run())}
      {button('table-col-left', 'Add a column on the left', <ColLeftIcon />, () => chain().addColumnBefore().run())}
      {button('table-col-right', 'Add a column on the right', <ColRightIcon />, () => chain().addColumnAfter().run())}
      <span className="format-sep" aria-hidden="true" />
      {button('table-row-delete', 'Delete this row', <span className="glyph small">− Row</span>, () => chain().deleteRow().run())}
      {button('table-col-delete', 'Delete this column', <span className="glyph small">− Col</span>, () => chain().deleteColumn().run())}
      {button('table-header', 'Turn the header row on or off', <HeaderRowIcon />, () => chain().toggleHeaderRow().run())}
      <span className="format-sep" aria-hidden="true" />
      {button('table-delete', 'Delete the table', <TrashIcon />, () => chain().deleteTable().run(), true)}
    </BubbleMenu>
  );
}
