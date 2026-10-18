/** What the sidebar does to the active container's boards: rename, file under a session, delete, one or many at a time. */

import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { ContextMenu, type MenuPoint } from './ContextMenu';
import { FileUnder, FilingList, type FilingTab } from './FilingMenu';
import { DeleteItem } from './FooterMenu';
import { CloseIcon, PencilIcon, TrashIcon } from './Icons';

export interface BoardActions {
  rename: (from: string, to: string) => void;
  /** Moves boards to the Trash. */
  remove: (names: string[]) => void;
  /** Files boards under a session, or under Unfiled when `sessionId` is undefined. */
  file: (names: string[], sessionId: string | undefined) => void;
}

/** "1 board", "3 boards". */
export const boardCount = (n: number) => `${n} ${n === 1 ? 'board' : 'boards'}`;

export interface BoardSelection {
  /** The selected boards, in list order. */
  selected: string[];
  /** ⌘-click toggles a board, ⇧-click selects a range, and a plain click clears the selection. Returns true when it only selected. */
  click: (e: MouseEvent, name: string) => boolean;
  clear: () => void;
}

/** Picks boards with ⌘ and ⇧, as Finder does. A range starts at the last ⌘-click, else at the open board. */
export function useBoardSelection(names: string[], open: string, container: string | undefined): BoardSelection {
  const [picked, setPicked] = useState<string[]>([]);
  const [anchor, setAnchor] = useState<string>();
  const selected = names.filter((n) => picked.includes(n));

  useEffect(() => {
    setPicked([]);
    setAnchor(undefined);
  }, [container]);

  const click = (e: MouseEvent, name: string) => {
    if (e.metaKey) {
      setPicked(selected.includes(name) ? selected.filter((n) => n !== name) : [...selected, name]);
      setAnchor(name);
      return true;
    }
    if (e.shiftKey) {
      const from = names.indexOf(anchor && names.includes(anchor) ? anchor : open);
      const to = names.indexOf(name);
      setPicked(from < 0 ? [name] : names.slice(Math.min(from, to), Math.max(from, to) + 1));
      return true;
    }
    setPicked([]);
    setAnchor(name);
    return false;
  };
  return { selected, click, clear: () => setPicked([]) };
}

/** The ⋯ and right-click menu for one board, or for every selected board. */
export function BoardMenu(props: {
  names: string[];
  at: MenuPoint;
  /** The session the boards are filed under. Undefined means Unfiled. */
  container: string | undefined;
  tabs: FilingTab[];
  actions: BoardActions;
  onRename: (name: string) => void;
  onClose: () => void;
  /** The boards left the list, so the selection empties. */
  onDone: () => void;
}) {
  const { names, actions } = props;
  const many = names.length > 1;
  const done = (fn: () => void) => () => {
    props.onClose();
    props.onDone();
    fn();
  };
  return (
    <ContextMenu x={props.at.x} y={props.at.y} label={many ? boardCount(names.length) : `Board ${names[0]}`} testId="board-row-menu" onClose={props.onClose}>
      {many ? (
        <h4>{boardCount(names.length)}</h4>
      ) : (
        <button
          className="ghost"
          role="menuitem"
          onClick={() => {
            props.onClose();
            props.onRename(names[0]);
          }}
          data-testid="board-row-rename"
        >
          <PencilIcon /> <span className="label-text">Rename</span>
        </button>
      )}
      <FileUnder
        filed={props.container}
        tabs={props.tabs}
        testId="board-file-under"
        close={props.onClose}
        onFile={(sessionId) => sessionId !== props.container && done(() => actions.file(names, sessionId))()}
      />
      <hr />
      <DeleteItem what={many ? boardCount(names.length) : 'board'} testId="board-row-delete" onDelete={done(() => actions.remove(names))} />
    </ContextMenu>
  );
}

/** Shows while boards are selected: File under…, Delete, and clear. Escape clears too. */
export function SelectionBar(props: {
  selection: BoardSelection;
  container: string | undefined;
  tabs: FilingTab[];
  actions: BoardActions;
}) {
  const { selected, clear } = props.selection;
  const [open, setOpen] = useState<{ kind: 'file' | 'delete' } & MenuPoint>();
  const bar = useRef<HTMLDivElement>(null);

  // An open menu takes Escape first, so the selection stays. The capture phase sees the menu before it closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !document.querySelector('.context-menu') && clear();
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [clear]);

  const show = (kind: 'file' | 'delete') => {
    const box = bar.current?.getBoundingClientRect();
    if (box) setOpen({ kind, x: box.left, y: box.top - 6 });
  };
  const finish = (fn: () => void) => {
    setOpen(undefined);
    clear();
    fn();
  };
  const count = boardCount(selected.length);
  return (
    <div className="selection-bar" ref={bar} role="toolbar" aria-label="Selected boards" data-escape-owner data-testid="board-selection">
      <span className="count">{selected.length} selected</span>
      <button className="ghost small" onClick={() => show('file')} data-testid="selection-file">
        File under…
      </button>
      <button
        className="ghost icon-button small danger"
        aria-label={`Delete ${count}`}
        title="Move to the Trash"
        onClick={() => show('delete')}
        data-testid="selection-delete"
      >
        <TrashIcon />
      </button>
      <button className="ghost icon-button small" aria-label="Clear selection" title="Clear selection (Esc)" onClick={clear} data-testid="selection-clear">
        <CloseIcon />
      </button>
      {open?.kind === 'file' && (
        <ContextMenu x={open.x} y={open.y} up label={`File ${count} under`} testId="selection-menu" onClose={() => setOpen(undefined)}>
          <h4>File {count} under</h4>
          <FilingList
            tabs={props.tabs}
            filed={props.container}
            onFile={(sessionId) => (sessionId === props.container ? setOpen(undefined) : finish(() => props.actions.file(selected, sessionId)))}
          />
        </ContextMenu>
      )}
      {open?.kind === 'delete' && (
        <ContextMenu x={open.x} y={open.y} up label={`Delete ${count}`} testId="selection-menu" onClose={() => setOpen(undefined)}>
          <p className="confirm-text">
            <strong>Delete {count}?</strong> They go to the Trash.
          </p>
          <div className="confirm-actions">
            <button className="ghost" onClick={() => setOpen(undefined)} data-testid="selection-cancel">
              Cancel
            </button>
            <button className="ghost danger" onClick={() => finish(() => props.actions.remove(selected))} data-testid="selection-confirm-delete">
              Delete
            </button>
          </div>
        </ContextMenu>
      )}
    </div>
  );
}

/** Renames a board in its row. Enter or leaving the field saves, Escape cancels. */
export function RenameField(props: { name: string; onDone: (to?: string) => void }) {
  const [draft, setDraft] = useState(props.name);
  const ended = useRef(false);
  const end = (to?: string) => {
    if (ended.current) return;
    ended.current = true;
    const name = to?.trim();
    props.onDone(name && name !== props.name ? name : undefined);
  };
  return (
    <input
      className="child rename"
      autoFocus
      value={draft}
      aria-label={`Rename ${props.name}`}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') end(draft);
        if (e.key === 'Escape') end();
      }}
      onBlur={() => end(draft)}
      data-escape-owner
      data-testid="board-row-name"
    />
  );
}
