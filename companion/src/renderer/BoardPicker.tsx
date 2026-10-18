import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { BoardLayout } from '../protocol';
import type { BoardEntry } from '../shared/ipc';
import { pickerRows } from './boardScope';
import { CheckIcon, ChevronIcon, DetachIcon, PencilIcon, PlusIcon, StackIcon, TrashIcon } from './Icons';
import { useEscape, usePointerOutside } from './hooks';

type Mode = { kind: 'idle' } | { kind: 'new' } | { kind: 'rename' };

const LAYOUTS: { layout: BoardLayout; label: string; title: string }[] = [
  { layout: 'freeform', label: 'Canvas', title: 'Canvas: place things anywhere' },
  { layout: 'stack', label: 'Stack', title: 'Stack: each drop or paste of screenshots becomes a numbered group' },
];

/** Canvas or Stack, for the open board or a new one. */
export function LayoutSwitch(props: { layout: BoardLayout; onChange: (layout: BoardLayout) => void }) {
  return (
    <div className="cluster layouts" role="radiogroup" aria-label="Board layout">
      {LAYOUTS.map((l) => (
        <button
          key={l.layout}
          type="button"
          role="radio"
          className="ghost"
          aria-checked={props.layout === l.layout}
          title={l.title}
          onClick={() => props.layout !== l.layout && props.onChange(l.layout)}
          data-testid={`layout-${l.layout}`}
        >
          {l.label}
        </button>
      ))}
    </div>
  );
}

/**
 * The board's name opens a menu of the active container's boards, with New and
 * Rename at its foot. Each row can be deleted. A live session also lists the
 * unfiled boards it can attach. On a session tab each row can also detach,
 * which moves the board to Unfiled.
 *
 * While the sidebar lists the container's boards, the menu keeps only New and
 * Attach. Each sidebar row carries its own Rename, File under and Delete.
 */
export function BoardPicker(props: {
  boards: BoardEntry[];
  /** Fetches the board list again. The menu calls it as it opens. */
  onRefresh: () => void;
  board: string;
  /** The active session, or undefined on Unfiled. */
  sessionId?: string;
  /** The active session is live, so it can take an unfiled board. */
  canAttach: boolean;
  /** The sidebar lists the container's boards, so the menu holds only actions. */
  listed?: boolean;
  /** Bumped to open the new-board field, as the tray and File menu do. */
  newRequest?: number;
  onSwitch: (name: string) => void;
  onCreate: (name: string, layout: BoardLayout) => void;
  onRename: (name: string) => void;
  onDelete: (name: string) => Promise<void>;
  /** Moves a board out of the active session to Unfiled. */
  onDetach: (name: string) => Promise<void>;
}) {
  const [mode, setMode] = useState<Mode>({ kind: 'idle' });
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [newLayout, setNewLayout] = useState<BoardLayout>('freeform');
  /** The board whose trash button was clicked once and now asks to confirm. */
  const [confirming, setConfirming] = useState<string>();
  const ref = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const close = useCallback(() => {
    setOpen(false);
    setConfirming(undefined);
  }, []);

  useEffect(() => {
    if (!props.newRequest) return;
    setDraft('');
    setNewLayout('freeform');
    setOpen(false);
    setMode({ kind: 'new' });
  }, [props.newRequest]);

  usePointerOutside(ref, () => setOpen(false), { active: open });

  const submit = () => {
    const name = draft.trim();
    if (name && mode.kind === 'new') props.onCreate(name, newLayout);
    if (name && mode.kind === 'rename') props.onRename(name);
    setMode({ kind: 'idle' });
  };
  const start = (kind: 'new' | 'rename') => {
    setOpen(false);
    setDraft(kind === 'rename' ? props.board : '');
    setNewLayout('freeform');
    setMode({ kind });
  };

  if (mode.kind !== 'idle') {
    return (
      <form
        className="boards"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && setMode({ kind: 'idle' })}
      >
        <input
          ref={field}
          autoFocus
          data-testid="board-name"
          value={draft}
          placeholder={mode.kind === 'new' ? 'New board name' : 'Rename board'}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && setMode({ kind: 'idle' })}
        />
        {mode.kind === 'new' && (
          <LayoutSwitch
            layout={newLayout}
            onChange={(layout) => {
              setNewLayout(layout);
              field.current?.focus();
            }}
          />
        )}
      </form>
    );
  }

  const { own, attach } = pickerRows(props.boards, props.board, props.sessionId, props.canAttach);
  const stacks = new Set(props.boards.filter((b) => b.layout === 'stack').map((b) => b.name));
  const stackMark = (n: string) =>
    stacks.has(n) && (
      <span className="layout-mark" title="Stack board" data-testid="board-stack-mark">
        <StackIcon />
      </span>
    );
  return (
    <div className="boards anchor" ref={ref}>
      <button
        className="ghost board-trigger"
        aria-haspopup="menu"
        aria-pressed={open}
        title="Boards"
        onClick={() => {
          if (!open) props.onRefresh();
          setOpen((o) => !o);
        }}
        data-testid="board-picker"
      >
        <span className="name">{props.board}</span>
        <ChevronIcon />
      </button>
      {open && (
        <BoardMenu onClose={close}>
          {props.listed ? (
            <div className="menu-foot" role="menu" aria-label="Board actions">
              <button className="ghost" role="menuitem" onClick={() => start('new')} data-testid="board-new">
                <PlusIcon /> New board
              </button>
            </div>
          ) : (
            <ul role="menu" aria-label="Boards">
              {own.map((n) => (
                <li key={n} className="board-row" onMouseLeave={() => confirming === n && setConfirming(undefined)}>
                  <button
                    className="ghost"
                    role="menuitemradio"
                    aria-checked={n === props.board}
                    onClick={() => {
                      setOpen(false);
                      if (n !== props.board) props.onSwitch(n);
                    }}
                    data-testid="board-item"
                  >
                    <span className="name">{n}</span>
                    {stackMark(n)}
                    {n === props.board && <CheckIcon />}
                  </button>
                  {props.sessionId && confirming !== n && (
                    <button
                      className="ghost icon-button small detach"
                      aria-label={`Detach ${n}`}
                      title="Move to Unfiled"
                      onClick={() => void props.onDetach(n).then(props.onRefresh)}
                      data-testid="board-detach"
                    >
                      <DetachIcon />
                    </button>
                  )}
                  <button
                    className={confirming === n ? 'ghost delete confirm' : 'ghost icon-button small delete'}
                    aria-label={confirming === n ? `Confirm delete ${n}` : `Delete ${n}`}
                    title={confirming === n ? undefined : 'Move to the Trash'}
                    onClick={() => {
                      if (confirming !== n) return setConfirming(n);
                      setConfirming(undefined);
                      void props.onDelete(n).then(props.onRefresh);
                    }}
                    data-testid="board-delete"
                  >
                    {confirming === n ? 'Delete' : <TrashIcon />}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {attach.length > 0 && (
            <div className="attach">
              <h3>Attach an unfiled board</h3>
              <ul role="menu" aria-label="Attach an unfiled board">
                {attach.map((n) => (
                  <li key={n}>
                    <button
                      className="ghost"
                      role="menuitem"
                      onClick={() => {
                        setOpen(false);
                        props.onSwitch(n);
                      }}
                      data-testid="board-attach"
                    >
                      <span className="name">{n}</span>
                      {stackMark(n)}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {!props.listed && (
            <div className="menu-foot">
              <button className="ghost" onClick={() => start('new')} data-testid="board-new">
                <PlusIcon /> New board
              </button>
              <button className="ghost" onClick={() => start('rename')} data-testid="board-rename">
                <PencilIcon /> Rename “{props.board}”
              </button>
            </div>
          )}
        </BoardMenu>
      )}
    </div>
  );
}

function BoardMenu(props: { onClose: () => void; children: ReactNode }) {
  useEscape(props.onClose);
  return (
    <div className="popover-panel board-menu" data-escape-owner data-testid="board-menu">
      {props.children}
    </div>
  );
}
