import { Fragment, useEffect, useState, type MouseEvent } from 'react';
import type { BoardEntry, Mode, SessionBriefEntry } from '../shared/ipc';
import { folderName, modeLabel, shortPath } from '../shared/sessions';
import { boardsOf, childrenOf } from './boardScope';
import { CleanupSheet, type CleanupHost } from './CleanupSheet';
import { ContextMenu, type MenuPoint } from './ContextMenu';
import type { DraftBook } from './drafts';
import type { FilingTab } from './FilingMenu';
import { useStore } from './hooks';
import { AllSessions } from './AllSessions';
import { BoardIcon, ChevronIcon, CloseIcon, MoreIcon, NotesIcon, PinIcon, StackIcon } from './Icons';
import { BoardMenu, RenameField, SelectionBar, useBoardSelection, type BoardActions, type BoardSelection } from './SidebarBoards';
import { ago } from './WriteView';

/** Below this width the sidebar opens over the work instead of beside it. */
const NARROW = '(max-width: 719px)';
const HIDDEN_KEY = 'sidebar.hidden';
const RECENT_CLOSED_KEY = 'sidebar.recentClosed';
const DONE_KEY = 'sidebar.doneOpen';

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
export function whereLine(b: SessionBriefEntry): string {
  return [sessionState(b).label, b.cwd && folderName(b.cwd)].filter(Boolean).join(' · ');
}

/** Ended sessions the Recent group lists. All sessions lists the rest. */
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
  /** Opens a board in its own container, switching to it first. */
  onOpenAnywhere: (board: BoardEntry) => void;
  actions: BoardActions;
}

/** The boards a container lists, and the done ones it folds away. The open board always stays listed. */
export function splitDone(boards: readonly BoardEntry[], open: string | undefined): { listed: BoardEntry[]; folded: BoardEntry[] } {
  const listed = boards.filter((b) => !b.done || b.name === open);
  return { listed, folded: boards.filter((b) => !listed.includes(b)) };
}

/** "1 note", "3 notes". */
export const noteCountLabel = (n: number) => `${n} ${n === 1 ? 'note' : 'notes'}`;

/**
 * Pinned boards, Unfiled, then each Claude Code session's brief: running sessions
 * first, then the newest ended ones under Recent. All sessions lists every one.
 * The active session is the one Send goes to. The active container lists its
 * boards and a note count under its row, with done boards folded away.
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
  cleanup: CleanupHost;
  onNotify: (text: string) => void;
}) {
  const [endedOpen, setEndedOpen] = useState(() => !readFlag(RECENT_CLOSED_KEY));
  const [doneOpen, setDoneOpen] = useState(() => readFlag(DONE_KEY));
  const [allOpen, setAllOpen] = useState(false);
  const [cleaning, setCleaning] = useState<SessionBriefEntry[]>();
  const { running, ended } = groupBriefs(props.briefs);
  const { sidebar } = props;

  // Recent lists the newest few. A folded group, or one the active session fell out of, still shows the active one.
  const endedListed = endedOpen ? ended.slice(0, ENDED_SHOWN) : [];
  const endedShown = ended.filter((b) => endedListed.includes(b) || b.sessionId === props.activeId);
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
    onCleanUp: (b: SessionBriefEntry) => setCleaning([b]),
  };
  const tabs = props.briefs.map((b) => b.sessionId);
  const { contents } = props;
  const filing: FilingTab[] = [...running, ...ended].map((b) => ({ sessionId: b.sessionId, title: b.title, where: whereLine(b) }));
  const open = contents.mode === 'sketch' ? contents.board : undefined;
  const split = splitDone(boardsOf(contents.boards, props.activeId), open);
  const names = [...split.listed, ...(doneOpen ? split.folded : [])].map((b) => b.name);
  const selection = useBoardSelection(names, contents.board, props.activeId);
  const pinned = contents.boards.filter((b) => b.pinned);
  const titleOf = (sessionId: string | undefined) => (sessionId ? (props.briefs.find((b) => b.sessionId === sessionId)?.title ?? 'Ended session') : 'Unfiled');
  const childList = (sessionId: string | undefined) => (
    <Children
      {...contents}
      sessionId={sessionId}
      tabs={tabs}
      filing={filing}
      selection={selection}
      doneOpen={doneOpen}
      onDoneOpen={(on) => {
        writeFlag(DONE_KEY, on);
        setDoneOpen(on);
      }}
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
          {pinned.length > 0 && (
            <Pinned
              boards={pinned}
              open={open}
              titleOf={titleOf}
              filing={filing}
              actions={contents.actions}
              onOpen={(b) => picked(() => contents.onOpenAnywhere(b))}
            />
          )}
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
              title="Ended sessions, newest first"
              onClick={() => {
                writeFlag(RECENT_CLOSED_KEY, endedOpen);
                setEndedOpen(!endedOpen);
              }}
              data-testid="ended-toggle"
            >
              <ChevronIcon />
              Recent
            </button>
          )}
          {endedShown.map(row)}
          {props.briefs.length > 0 && (
            <button className="ghost group more" title="Find any session or board" onClick={() => setAllOpen(true)} data-testid="all-sessions">
              All sessions <span className="count">{props.briefs.length}</span>
            </button>
          )}
        </div>
        {selection.selected.length > 0 && (
          <SelectionBar selection={selection} container={props.activeId} tabs={filing} actions={contents.actions} />
        )}
      </nav>
      {allOpen && (
        <AllSessions
          briefs={props.briefs}
          boards={contents.boards}
          activeId={props.activeId}
          onSwitch={(id) => picked(() => props.onSwitch(id))}
          onUnfiled={() => picked(props.onNotes)}
          onOpenBoard={(b) => picked(() => contents.onOpenAnywhere(b))}
          onCleanUp={(briefs) => setCleaning(briefs)}
          onClose={() => setAllOpen(false)}
        />
      )}
      {cleaning && (
        <CleanupSheet
          host={props.cleanup}
          sessions={cleaning.map((b) => ({ sessionId: b.sessionId, title: b.title }))}
          onDone={props.onNotify}
          onClose={() => setCleaning(undefined)}
        />
      )}
    </>
  );
}

/**
 * The active container's boards, then its note count, then its done boards folded
 * under Done. Each board has a ⋯ and right-click menu. ⌘ and ⇧ select several.
 */
function Children(
  props: ChildProps & {
    sessionId?: string;
    tabs: string[];
    filing: FilingTab[];
    selection: BoardSelection;
    doneOpen: boolean;
    onDoneOpen: (on: boolean) => void;
  },
) {
  const book = useStore(props.book);
  const [menu, setMenu] = useState<{ names: string[]; at: MenuPoint }>();
  const [renaming, setRenaming] = useState<string>();
  const { selection } = props;
  const kids = childrenOf(props.boards, book.drafts, props.sessionId, props.tabs);
  if (!kids.boards.length && !kids.noteCount) return null;
  const { listed, folded } = splitDone(kids.boards, props.mode === 'sketch' ? props.board : undefined);

  /** A selected board's menu acts on the whole selection. Any other board's acts on it alone. */
  const openMenu = (name: string, at: MenuPoint) => {
    const many = selection.selected.length > 1 && selection.selected.includes(name);
    if (!many) selection.clear();
    setMenu({ names: many ? selection.selected : [name], at });
  };
  const row = (b: BoardEntry) => (
    <BoardRow
      key={b.name}
      board={b}
      current={props.mode === 'sketch' && b.name === props.board}
      selected={selection.selected.includes(b.name)}
      renaming={renaming === b.name}
      menuOpen={!!menu?.names.includes(b.name)}
      onClick={(e) => selection.click(e, b.name) || props.onOpenBoard(b.name)}
      onMenu={(at) => openMenu(b.name, at)}
      onRenameStart={() => setRenaming(b.name)}
      onRenamed={(to) => {
        setRenaming(undefined);
        if (to) props.actions.rename(b.name, to);
      }}
    />
  );
  const marked = (names: string[]) => kids.boards.filter((b) => names.includes(b.name));

  return (
    <ul className="children" aria-label="Boards and notes" data-testid="brief-children">
      {listed.map(row)}
      {kids.noteCount > 0 && (
        <li>
          <button className="ghost child note-count" title="Open in Write" onClick={props.onNotes} data-testid="brief-notes">
            {noteCountLabel(kids.noteCount)}
          </button>
        </li>
      )}
      {folded.length > 0 && (
        <li>
          <button
            className="ghost child done-toggle"
            aria-expanded={props.doneOpen}
            title="Boards you sent or marked done. Editing one brings it back."
            onClick={() => props.onDoneOpen(!props.doneOpen)}
            data-testid="done-toggle"
          >
            <ChevronIcon />
            Done <span className="count">{folded.length}</span>
          </button>
        </li>
      )}
      {props.doneOpen && folded.map(row)}
      {menu && (
        <BoardMenu
          names={menu.names}
          at={menu.at}
          container={props.sessionId}
          tabs={props.filing}
          actions={props.actions}
          pinned={marked(menu.names).every((b) => b.pinned)}
          done={marked(menu.names).every((b) => b.done)}
          onRename={setRenaming}
          onClose={() => setMenu(undefined)}
          onDone={selection.clear}
        />
      )}
    </ul>
  );
}

/** Pinned boards from every container, each naming where it is filed. */
function Pinned(props: {
  boards: BoardEntry[];
  open: string | undefined;
  titleOf: (sessionId: string | undefined) => string;
  filing: FilingTab[];
  actions: BoardActions;
  onOpen: (board: BoardEntry) => void;
}) {
  const [menu, setMenu] = useState<{ board: BoardEntry; at: MenuPoint }>();
  const [renaming, setRenaming] = useState<string>();
  return (
    <>
      <h3 className="group">Pinned</h3>
      <ul className="children pinned" aria-label="Pinned boards" data-testid="pinned">
        {props.boards.map((b) => (
          <BoardRow
            key={b.name}
            board={b}
            meta={props.titleOf(b.sessionId)}
            current={b.name === props.open}
            renaming={renaming === b.name}
            menuOpen={menu?.board.name === b.name}
            onClick={() => props.onOpen(b)}
            onMenu={(at) => setMenu({ board: b, at })}
            onRenameStart={() => setRenaming(b.name)}
            onRenamed={(to) => {
              setRenaming(undefined);
              if (to) props.actions.rename(b.name, to);
            }}
          />
        ))}
      </ul>
      {menu && (
        <BoardMenu
          names={[menu.board.name]}
          at={menu.at}
          container={menu.board.sessionId}
          tabs={props.filing}
          actions={props.actions}
          pinned
          done={!!menu.board.done}
          onRename={setRenaming}
          onClose={() => setMenu(undefined)}
          onDone={() => undefined}
        />
      )}
    </>
  );
}

/** One board in the sidebar: its icon and name, a ⋯ on hover, and a field while it is renamed. */
function BoardRow(props: {
  board: BoardEntry;
  /** Where the board is filed, shown after its name. */
  meta?: string;
  current: boolean;
  selected?: boolean;
  renaming: boolean;
  menuOpen: boolean;
  onClick: (e: MouseEvent) => void;
  onMenu: (at: MenuPoint) => void;
  onRenameStart: () => void;
  onRenamed: (to?: string) => void;
}) {
  const b = props.board;
  return (
    <li className="board-row" data-selected={!!props.selected} data-done={!!b.done}>
      {props.renaming ? (
        <RenameField name={b.name} onDone={props.onRenamed} />
      ) : (
        <button
          className="ghost child"
          title={`${b.name}${b.layout === 'stack' ? ' · Stack board' : ''}${props.meta ? ` · ${props.meta}` : ''}\nOpen in Sketch. ⌘-click to select.`}
          aria-current={props.current}
          onClick={props.onClick}
          onDoubleClick={props.onRenameStart}
          onContextMenu={(e) => {
            e.preventDefault();
            props.onMenu({ x: e.clientX, y: e.clientY });
          }}
          data-testid="brief-board"
        >
          {b.pinned && !props.meta ? (
            <span className="layout-mark" title="Pinned" data-testid="board-pin-mark">
              <PinIcon />
            </span>
          ) : b.layout === 'stack' ? (
            <span className="layout-mark" data-testid="board-stack-mark">
              <StackIcon />
            </span>
          ) : (
            <BoardIcon />
          )}
          <span className="title">{b.name}</span>
          {props.meta && <span className="meta">{props.meta}</span>}
        </button>
      )}
      {!props.renaming && (
        <button
          className="ghost icon-button small more"
          aria-label={`More for ${b.name}`}
          aria-haspopup="menu"
          aria-expanded={props.menuOpen}
          title="Rename, copy a reference, pin, mark done, file under a session, or delete"
          onClick={(e) => {
            const box = e.currentTarget.getBoundingClientRect();
            props.onMenu({ x: box.left, y: box.bottom + 4 });
          }}
          data-testid="board-more"
        >
          <MoreIcon />
        </button>
      )}
    </li>
  );
}

function Row(props: {
  brief: SessionBriefEntry;
  activeId?: string;
  home?: string;
  onSwitch: (sessionId: string) => void;
  onClose: (sessionId: string) => void;
  onFocus: (sessionId: string) => void;
  onCleanUp: (brief: SessionBriefEntry) => void;
}) {
  const [menu, setMenu] = useState<MenuPoint>();
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
      {!b.isLive && (
        <button
          className="ghost icon-button small more"
          aria-label={`More for ${b.title}`}
          aria-haspopup="menu"
          aria-expanded={!!menu}
          title="Clean up what this session left"
          onClick={(e) => {
            const box = e.currentTarget.getBoundingClientRect();
            setMenu({ x: box.left, y: box.bottom + 4 });
          }}
          data-testid="brief-more"
        >
          <MoreIcon />
        </button>
      )}
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} label={`Session ${b.title}`} testId="brief-menu" onClose={() => setMenu(undefined)}>
          <button
            className="ghost"
            role="menuitem"
            onClick={() => {
              setMenu(undefined);
              props.onCleanUp(b);
            }}
            data-testid="brief-cleanup"
          >
            Clean up…
          </button>
        </ContextMenu>
      )}
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
