import { Fragment, useEffect, useState, type MouseEvent } from 'react';
import type { BoardEntry, Mode, SessionBriefEntry } from '../shared/ipc';
import { folderName, modeLabel, shortPath } from '../shared/sessions';
import { boardsOf, childrenOf } from './boardScope';
import type { MenuPoint } from './ContextMenu';
import type { DraftBook } from './drafts';
import type { FilingTab } from './FilingMenu';
import { useStore } from './hooks';
import { BoardIcon, ChevronIcon, CloseIcon, MoreIcon, NotesIcon, StackIcon } from './Icons';
import { BoardMenu, RenameField, SelectionBar, useBoardSelection, type BoardActions, type BoardSelection } from './SidebarBoards';
import { ago } from './WriteView';

/** Below this width the sidebar opens over the work instead of beside it. */
const NARROW = '(max-width: 719px)';
const HIDDEN_KEY = 'sidebar.hidden';
const ENDED_KEY = 'sidebar.endedOpen';

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function writeFlag(key: string, on: boolean): void {
  try {
    localStorage.setItem(key, on ? '1' : '0');
  } catch {
    // The flag only saves a preference, so a failed write changes nothing else.
  }
}

/** What a session is doing: working, idle, or ended. */
export function sessionState(b: Pick<SessionBriefEntry, 'isLive' | 'isWorking' | 'activeAt' | 'at'>, now = Date.now()): { label: string; tip: string } {
  if (b.isWorking) return { label: 'Working', tip: 'Working: Claude is replying' };
  if (b.isLive) return { label: b.activeAt ? `Idle ${ago(b.activeAt, now)}` : 'Idle', tip: 'Idle: waiting for your next prompt' };
  return { label: ago(b.at, now), tip: 'Ended: Claude Code closed. Resume it from here' };
}

/** A session's second line: its state, and its folder's name. */
function whereLine(b: SessionBriefEntry): string {
  return [sessionState(b).label, b.cwd && folderName(b.cwd)].filter(Boolean).join(' · ');
}

/** Ended sessions shown before "Show more". */
export const ENDED_SHOWN = 5;

/** Splits the briefs into running and ended sessions, each newest first. */
export function groupBriefs(briefs: SessionBriefEntry[]): { running: SessionBriefEntry[]; ended: SessionBriefEntry[] } {
  return { running: briefs.filter((b) => b.isLive), ended: briefs.filter((b) => !b.isLive) };
}

/** The sessions in the order the sidebar lists them, which ⌃1–9 and ⌃Tab follow. */
export function sidebarOrder(briefs: SessionBriefEntry[]): string[] {
  const { running, ended } = groupBriefs(briefs);
  return [...running, ...ended].map((b) => b.sessionId);
}

export interface SidebarState {
  open: boolean;
  /** The sidebar covers the work, and a pick closes it. */
  overlay: boolean;
  toggle: () => void;
  dismiss: () => void;
}

/** Wide panels keep the sidebar beside the work and remember when it is hidden. Narrow ones open it as a drawer. */
export function useSidebar(): SidebarState {
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW).matches);
  const [hidden, setHidden] = useState(() => readFlag(HIDDEN_KEY));
  const [drawer, setDrawer] = useState(false);

  useEffect(() => {
    const query = window.matchMedia(NARROW);
    const onChange = () => {
      setNarrow(query.matches);
      setDrawer(false);
    };
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  const toggle = () => {
    if (narrow) return setDrawer((o) => !o);
    writeFlag(HIDDEN_KEY, !hidden);
    setHidden(!hidden);
  };
  return { open: narrow ? drawer : !hidden, overlay: narrow, toggle, dismiss: () => setDrawer(false) };
}

/** What the active container lists under its row, and what a click on one does. */
export interface ChildProps {
  boards: BoardEntry[];
  book: DraftBook;
  /** The open board. */
  board: string;
  mode: Mode;
  onOpenBoard: (name: string) => void;
  /** The note count opens Write view, which lists the container's notes. */
  onNotes: () => void;
  actions: BoardActions;
}

/** "1 note", "3 notes". */
export const noteCountLabel = (n: number) => `${n} ${n === 1 ? 'note' : 'notes'}`;

/**
 * Unfiled, then each Claude Code session's brief: running sessions first, ended
 * ones in a group that folds away. The active session is the one Send goes to.
 * The active container lists its boards and a note count under its row.
 */
export function SessionSidebar(props: {
  briefs: SessionBriefEntry[];
  /** The active session. Undefined when Unfiled is active. */
  activeId?: string;
  home?: string;
  sidebar: SidebarState;
  onNotes: () => void;
  onSwitch: (sessionId: string) => void;
  onClose: (sessionId: string) => void;
  /** A click on the active session brings its terminal forward. */
  onFocus: (sessionId: string) => void;
  contents: ChildProps;
}) {
  const [endedOpen, setEndedOpen] = useState(() => readFlag(ENDED_KEY));
  const [allEnded, setAllEnded] = useState(false);
  const { running, ended } = groupBriefs(props.briefs);
  const { sidebar } = props;

  // The group shows its newest few until "Show more". A folded or cut group still shows the ended session on show.
  const endedListed = !endedOpen ? [] : allEnded ? ended : ended.slice(0, ENDED_SHOWN);
  const endedShown = ended.filter((b) => endedListed.includes(b) || b.sessionId === props.activeId);
  const endedMore = endedOpen && ended.length > ENDED_SHOWN;
  /** A pick in the drawer closes it. */
  const picked = (go: () => void) => {
    go();
    if (sidebar.overlay) sidebar.dismiss();
  };
  const rowProps = {
    activeId: props.activeId,
    home: props.home,
    onSwitch: (id: string) => picked(() => props.onSwitch(id)),
    onClose: props.onClose,
    onFocus: props.onFocus,
  };
  const tabs = props.briefs.map((b) => b.sessionId);
  const { contents } = props;
  const filing: FilingTab[] = [...running, ...ended].map((b) => ({ sessionId: b.sessionId, title: b.title, where: whereLine(b) }));
  const names = boardsOf(contents.boards, props.activeId).map((b) => b.name);
  const selection = useBoardSelection(names, contents.board, props.activeId);
  const childList = (sessionId: string | undefined) => (
    <Children
      {...contents}
      sessionId={sessionId}
      tabs={tabs}
      filing={filing}
      selection={selection}
      onOpenBoard={(name) => picked(() => contents.onOpenBoard(name))}
      onNotes={() => picked(contents.onNotes)}
    />
  );
  const row = (b: SessionBriefEntry) => (
    <Fragment key={b.sessionId}>
      <Row brief={b} {...rowProps} />
      {b.sessionId === props.activeId && childList(b.sessionId)}
    </Fragment>
  );

  if (!sidebar.open) return null;
  return (
    <>
      {sidebar.overlay && <button className="sidebar-scrim" aria-label="Close sessions" onClick={sidebar.dismiss} />}
      <nav className={sidebar.overlay ? 'sessions overlay' : 'sessions'} aria-label="Sessions" data-testid="brief-tabs">
        <div className="tabs" role="tablist" aria-orientation="vertical">
          <div className="tab notes-tab" aria-current={props.activeId === undefined} data-testid="notes-tab">
            <button
              className="ghost label"
              role="tab"
              aria-selected={props.activeId === undefined}
              title="Boards and notes that belong to no session. Send asks where to go."
              onClick={() => picked(() => props.activeId !== undefined && props.onNotes())}
            >
              <NotesIcon />
              <span className="title">Unfiled</span>
            </button>
          </div>
          {props.activeId === undefined && childList(undefined)}

          {running.length > 0 && <h3 className="group">Running</h3>}
          {running.map(row)}

          {ended.length > 0 && (
            <button
              className="ghost group toggle"
              aria-expanded={endedOpen}
              onClick={() => {
                writeFlag(ENDED_KEY, !endedOpen);
                setEndedOpen(!endedOpen);
              }}
              data-testid="ended-toggle"
            >
              <ChevronIcon />
              Ended <span className="count">{ended.length}</span>
            </button>
          )}
          {endedShown.map(row)}
          {endedMore && (
            <button className="ghost group more" onClick={() => setAllEnded(!allEnded)} data-testid="ended-more">
              {allEnded ? 'Show fewer' : `Show ${ended.length - ENDED_SHOWN} more`}
            </button>
          )}
        </div>
        {selection.selected.length > 0 && (
          <SelectionBar selection={selection} container={props.activeId} tabs={filing} actions={contents.actions} />
        )}
      </nav>
    </>
  );
}

/**
 * The active container's boards, then its note count, indented under its row.
 * Each board has a ⋯ and right-click menu. ⌘ and ⇧ select several.
 */
function Children(props: ChildProps & { sessionId?: string; tabs: string[]; filing: FilingTab[]; selection: BoardSelection }) {
  const book = useStore(props.book);
  const [menu, setMenu] = useState<{ names: string[]; at: MenuPoint }>();
  const [renaming, setRenaming] = useState<string>();
  const { selection } = props;
  const kids = childrenOf(props.boards, book.drafts, props.sessionId, props.tabs);
  if (!kids.boards.length && !kids.noteCount) return null;

  /** A selected board's menu acts on the whole selection. Any other board's acts on it alone. */
  const openMenu = (name: string, at: MenuPoint) => {
    const many = selection.selected.length > 1 && selection.selected.includes(name);
    if (!many) selection.clear();
    setMenu({ names: many ? selection.selected : [name], at });
  };
  const onContext = (e: MouseEvent, name: string) => {
    e.preventDefault();
    openMenu(name, { x: e.clientX, y: e.clientY });
  };

  return (
    <ul className="children" aria-label="Boards and notes" data-testid="brief-children">
      {kids.boards.map((b) => (
        <li key={b.name} className="board-row" data-selected={selection.selected.includes(b.name)}>
          {renaming === b.name ? (
            <RenameField
              name={b.name}
              onDone={(to) => {
                setRenaming(undefined);
                if (to) props.actions.rename(b.name, to);
              }}
            />
          ) : (
            <button
              className="ghost child"
              title={`${b.name}${b.layout === 'stack' ? ' · Stack board' : ''}\nOpen in Sketch. ⌘-click to select.`}
              aria-current={props.mode === 'sketch' && b.name === props.board}
              onClick={(e) => selection.click(e, b.name) || props.onOpenBoard(b.name)}
              onDoubleClick={() => setRenaming(b.name)}
              onContextMenu={(e) => onContext(e, b.name)}
              data-testid="brief-board"
            >
              {b.layout === 'stack' ? (
                <span className="layout-mark" data-testid="board-stack-mark">
                  <StackIcon />
                </span>
              ) : (
                <BoardIcon />
              )}
              <span className="title">{b.name}</span>
            </button>
          )}
          {renaming !== b.name && (
            <button
              className="ghost icon-button small more"
              aria-label={`More for ${b.name}`}
              aria-haspopup="menu"
              aria-expanded={!!menu?.names.includes(b.name)}
              title="Rename, copy a reference, file under a session, or delete"
              onClick={(e) => {
                const box = e.currentTarget.getBoundingClientRect();
                openMenu(b.name, { x: box.left, y: box.bottom + 4 });
              }}
              data-testid="board-more"
            >
              <MoreIcon />
            </button>
          )}
        </li>
      ))}
      {kids.noteCount > 0 && (
        <li>
          <button className="ghost child note-count" title="Open in Write" onClick={props.onNotes} data-testid="brief-notes">
            {noteCountLabel(kids.noteCount)}
          </button>
        </li>
      )}
      {menu && (
        <BoardMenu
          names={menu.names}
          at={menu.at}
          container={props.sessionId}
          tabs={props.filing}
          actions={props.actions}
          onRename={setRenaming}
          onClose={() => setMenu(undefined)}
          onDone={selection.clear}
        />
      )}
    </ul>
  );
}

function Row(props: {
  brief: SessionBriefEntry;
  activeId?: string;
  home?: string;
  onSwitch: (sessionId: string) => void;
  onClose: (sessionId: string) => void;
  onFocus: (sessionId: string) => void;
}) {
  const b = props.brief;
  const isActive = b.sessionId === props.activeId;
  const state = sessionState(b).tip;
  const where = whereLine(b);
  const path = b.cwd ? `\n${shortPath(b.cwd, props.home)}` : '';
  return (
    <div className="tab" aria-current={isActive} data-testid="brief-tab" data-session={b.sessionId}>
      <button
        className="ghost label"
        role="tab"
        aria-selected={isActive}
        title={`${b.title}${path}\n${state}${isActive && b.isLive ? '\nClick to bring its terminal forward' : ''}`}
        onClick={() => (isActive && b.isLive ? props.onFocus(b.sessionId) : props.onSwitch(b.sessionId))}
      >
        <SessionDot brief={b} />
        <span className="lines">
          <span className="line">
            <span className="title">{b.title}</span>
            {b.hasContent && (
              <span className="unsent" title="Not sent yet" aria-label="Not sent yet" data-testid="brief-unsent">
                •
              </span>
            )}
          </span>
          {where && <span className="where">{where}</span>}
          <ModeChip brief={b} />
        </span>
      </button>
      <button
        className="ghost icon-button small close"
        aria-label={`Close ${b.title}`}
        title="Remove from the list. The board and note stay."
        onClick={() => props.onClose(b.sessionId)}
        data-testid="brief-close"
      >
        <CloseIcon />
      </button>
    </div>
  );
}

/** Filled while the session runs, pulsing while Claude works, hollow once it ended. */
export function SessionDot(props: { brief: SessionBriefEntry }) {
  const b = props.brief;
  const kind = b.isWorking ? 'dot live working' : b.isLive ? 'dot live' : 'dot';
  return <span className={kind} aria-label={sessionState(b).tip} data-testid="session-dot" />;
}

/** The session's mode, mirrored from Claude Code. The panel only shows it. */
function ModeChip(props: { brief: SessionBriefEntry }) {
  const label = modeLabel(props.brief.mode, props.brief.fidelity);
  if (!label) return null;
  return (
    <span className="mode-chip" title={`${label} mode`} data-testid="brief-mode">
      {label}
    </span>
  );
}
