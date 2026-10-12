import { useEffect, useState } from 'react';
import type { SessionBriefEntry } from '../shared/ipc';
import { modeLabel, shortPath } from '../shared/sessions';
import { ChevronIcon, CloseIcon, NotesIcon } from './Icons';
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

/** A long path cut to its last two folders, which tell sessions apart. */
export function folderTail(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return path.length <= 28 || parts.length <= 2 ? path : `…/${parts.slice(-2).join('/')}`;
}

/** Splits the briefs into running and ended sessions, each newest first. */
export function groupBriefs(briefs: SessionBriefEntry[]): { running: SessionBriefEntry[]; ended: SessionBriefEntry[] } {
  return { running: briefs.filter((b) => b.isLive), ended: briefs.filter((b) => !b.isLive) };
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

/**
 * Notes, then each Claude Code session's brief: running sessions first, ended ones
 * in a group that folds away. The active session is the one Send goes to.
 */
export function SessionSidebar(props: {
  briefs: SessionBriefEntry[];
  /** The active session. Undefined when Notes is active. */
  activeId?: string;
  home?: string;
  sidebar: SidebarState;
  onNotes: () => void;
  onSwitch: (sessionId: string) => void;
  onClose: (sessionId: string) => void;
  /** A click on the active session brings its terminal forward. */
  onFocus: (sessionId: string) => void;
}) {
  const [endedOpen, setEndedOpen] = useState(() => readFlag(ENDED_KEY));
  const { running, ended } = groupBriefs(props.briefs);
  const { sidebar } = props;

  // A folded group still shows the ended session on show.
  const endedShown = endedOpen ? ended : ended.filter((b) => b.sessionId === props.activeId);
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
              title="Notes for no session, and scratch boards. Send asks where to go."
              onClick={() => picked(() => props.activeId !== undefined && props.onNotes())}
            >
              <NotesIcon />
              <span className="title">Notes</span>
            </button>
          </div>

          {running.length > 0 && <h3 className="group">Running</h3>}
          {running.map((b) => (
            <Row key={b.sessionId} brief={b} {...rowProps} />
          ))}

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
          {endedShown.map((b) => (
            <Row key={b.sessionId} brief={b} {...rowProps} />
          ))}
        </div>
      </nav>
    </>
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
  const state = b.isLive ? 'Running in Claude Code' : 'Session ended';
  const where = [!b.isLive && ago(b.at), b.cwd && folderTail(shortPath(b.cwd, props.home))].filter(Boolean).join(' · ');
  return (
    <div className="tab" aria-current={isActive} data-testid="brief-tab" data-session={b.sessionId}>
      <button
        className="ghost label"
        role="tab"
        aria-selected={isActive}
        title={`${b.title}\n${state}${isActive && b.isLive ? '\nClick to bring its terminal forward' : ''}`}
        onClick={() => (isActive && b.isLive ? props.onFocus(b.sessionId) : props.onSwitch(b.sessionId))}
      >
        <span className={b.isLive ? 'dot live' : 'dot'} aria-label={state} />
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
