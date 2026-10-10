import { useEffect, useState } from 'react';
import type { BoardEntry, BoardHost } from '../shared/ipc';
import { PencilIcon } from './Icons';

type Mode = { kind: 'idle' } | { kind: 'new' } | { kind: 'rename' };

export function BoardPicker(props: {
  host: Pick<BoardHost, 'listBoards'>;
  board: string;
  /** Bumped to open the new-board field, as the tray and File menu do. */
  newRequest?: number;
  /** Hosts that can only switch boards leave out new and rename. */
  canEdit?: boolean;
  onSwitch: (name: string) => void;
  onCreate: (name: string) => void;
  onRename: (name: string) => void;
}) {
  const [boards, setBoards] = useState<BoardEntry[]>([]);
  const [mode, setMode] = useState<Mode>({ kind: 'idle' });
  const [draft, setDraft] = useState('');

  const refresh = () => void props.host.listBoards().then(setBoards);
  useEffect(refresh, [props.board]);
  useEffect(() => {
    if (!props.newRequest) return;
    setDraft('');
    setMode({ kind: 'new' });
  }, [props.newRequest]);

  const submit = () => {
    const name = draft.trim();
    if (name && mode.kind === 'new') props.onCreate(name);
    if (name && mode.kind === 'rename') props.onRename(name);
    setMode({ kind: 'idle' });
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
    <div className="boards">
      <select data-testid="board-picker" value={props.board} onFocus={refresh} onChange={(e) => props.onSwitch(e.target.value)}>
        {names.map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </select>
      {props.canEdit !== false && (
        <>
          <button
            className="ghost"
            title="New board"
            data-testid="board-new"
            onClick={() => {
              setDraft('');
              setMode({ kind: 'new' });
            }}
          >
            +
          </button>
          <button
            className="ghost icon-button"
            title="Rename board"
            aria-label="Rename board"
            data-testid="board-rename"
            onClick={() => {
              setDraft(props.board);
              setMode({ kind: 'rename' });
            }}
          >
            <PencilIcon />
          </button>
        </>
      )}
    </div>
  );
}
