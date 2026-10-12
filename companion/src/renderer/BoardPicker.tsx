import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { BoardEntry, BoardHost } from '../shared/ipc';
import { CheckIcon, ChevronIcon, PencilIcon, PlusIcon, TrashIcon } from './Icons';
import { useEscape, usePointerOutside } from './hooks';

type Mode = { kind: 'idle' } | { kind: 'new' } | { kind: 'rename' };

/** The board's name opens a menu of boards, with New and Rename at its foot. Each row can be deleted. */
export function BoardPicker(props: {
  host: Pick<BoardHost, 'listBoards'>;
  board: string;
  /** Bumped to open the new-board field, as the tray and File menu do. */
  newRequest?: number;
  onSwitch: (name: string) => void;
  onCreate: (name: string) => void;
  onRename: (name: string) => void;
  onDelete: (name: string) => Promise<void>;
}) {
  const [boards, setBoards] = useState<BoardEntry[]>([]);
  const [mode, setMode] = useState<Mode>({ kind: 'idle' });
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  /** The board whose trash button was clicked once and now asks to confirm. */
  const [confirming, setConfirming] = useState<string>();
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => {
    setOpen(false);
    setConfirming(undefined);
  }, []);

  const refresh = () => void props.host.listBoards().then(setBoards);
  useEffect(refresh, [props.board]);
  useEffect(() => {
    if (!props.newRequest) return;
    setDraft('');
    setOpen(false);
    setMode({ kind: 'new' });
  }, [props.newRequest]);

  usePointerOutside(ref, () => setOpen(false), { active: open });

  const submit = () => {
    const name = draft.trim();
    if (name && mode.kind === 'new') props.onCreate(name);
    if (name && mode.kind === 'rename') props.onRename(name);
    setMode({ kind: 'idle' });
  };
  const start = (kind: 'new' | 'rename') => {
    setOpen(false);
    setDraft(kind === 'rename' ? props.board : '');
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
      >
        <input
          autoFocus
          data-testid="board-name"
          value={draft}
          placeholder={mode.kind === 'new' ? 'New board name' : 'Rename board'}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && setMode({ kind: 'idle' })}
          onBlur={() => setMode({ kind: 'idle' })}
        />
      </form>
    );
  }

  const names = boards.some((b) => b.name === props.board) ? boards.map((b) => b.name) : [props.board, ...boards.map((b) => b.name)];
  return (
    <div className="boards anchor" ref={ref}>
      <button
        className="ghost board-trigger"
        aria-haspopup="menu"
        aria-pressed={open}
        title="Boards"
        onClick={() => {
          if (!open) refresh();
          setOpen((o) => !o);
        }}
        data-testid="board-picker"
      >
        <span className="name">{props.board}</span>
        <ChevronIcon />
      </button>
      {open && (
        <BoardMenu onClose={close}>
          <ul role="menu" aria-label="Boards">
            {names.map((n) => (
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
                  {n === props.board && <CheckIcon />}
                </button>
                <button
                  className={confirming === n ? 'ghost delete confirm' : 'ghost icon-button small delete'}
                  aria-label={confirming === n ? `Confirm delete ${n}` : `Delete ${n}`}
                  title={confirming === n ? undefined : 'Move to the Trash'}
                  onClick={() => {
                    if (confirming !== n) return setConfirming(n);
                    setConfirming(undefined);
                    void props.onDelete(n).then(refresh);
                  }}
                  data-testid="board-delete"
                >
                  {confirming === n ? 'Delete' : <TrashIcon />}
                </button>
              </li>
            ))}
          </ul>
          <div className="menu-foot">
            <button className="ghost" onClick={() => start('new')} data-testid="board-new">
              <PlusIcon /> New board
            </button>
            <button className="ghost" onClick={() => start('rename')} data-testid="board-rename">
              <PencilIcon /> Rename “{props.board}”
            </button>
          </div>
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
