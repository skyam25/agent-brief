import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { SessionBriefEntry } from '../shared/ipc';
import { modeLabel, shortPath } from '../shared/sessions';
import { CheckIcon, ChevronIcon, CloseIcon, NotesIcon } from './Icons';
import { ago } from './WriteView';

/** A tab's width, its gap, and the "+N" button's width, which decide how many tabs fit. */
const TAB_W = 176;
const GAP = 2;
const MORE_W = 64;
/** The fixed Notes tab with its divider, and the row's side padding. */
const NOTES_W = 104;
const ROW_PAD = 24;

/** How many tabs show in `width`, leaving room for the overflow button when some must hide. */
export function tabsThatFit(count: number, width: number): number {
  if (count * (TAB_W + GAP) <= width) return count;
  return Math.max(1, Math.floor((width - MORE_W) / (TAB_W + GAP)));
}

/** The tabs on show: the first that fit, with the active one swapped in when it would hide. */
export function visibleTabs(briefs: SessionBriefEntry[], fit: number, activeId: string | undefined): SessionBriefEntry[] {
  const shown = briefs.slice(0, fit);
  const active = briefs.find((b) => b.sessionId === activeId);
  if (!active || shown.includes(active)) return shown;
  return [...shown.slice(0, Math.max(0, fit - 1)), active];
}

/**
 * The fixed Notes tab, then one tab per Claude Code session's brief, newest
 * first. The active session tab is the session Send goes to; Notes has no
 * session. Tabs that don't fit wait behind "+N".
 */
export function BriefTabs(props: {
  briefs: SessionBriefEntry[];
  /** The active session tab. Undefined when Notes is active. */
  activeId?: string;
  home?: string;
  onNotes: () => void;
  onSwitch: (sessionId: string) => void;
  onClose: (sessionId: string) => void;
  /** A click on the active tab brings its terminal forward. */
  onFocus: (sessionId: string) => void;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [moreOpen, setMoreOpen] = useState(false);

  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    const measure = () => setWidth(row.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    return () => observer.disconnect();
  }, []);

  const fit = width ? tabsThatFit(props.briefs.length, width - NOTES_W - ROW_PAD) : props.briefs.length;
  const shown = visibleTabs(props.briefs, fit, props.activeId);
  const hidden = props.briefs.length - shown.length;

  return (
    <nav className="brief-tabs" ref={rowRef} aria-label="Session briefs" data-testid="brief-tabs">
      <div className="tabs" role="tablist">
        <div className="tab notes-tab" aria-current={props.activeId === undefined} data-testid="notes-tab">
          <button
            className="ghost label"
            role="tab"
            aria-selected={props.activeId === undefined}
            title="Notes for no session, and scratch boards. Send asks where to go."
            onClick={() => props.activeId !== undefined && props.onNotes()}
          >
            <NotesIcon />
            <span className="title">Notes</span>
          </button>
        </div>
        <span className="tab-divider" aria-hidden="true" />
        {shown.map((b) => (
          <Tab key={b.sessionId} brief={b} isActive={b.sessionId === props.activeId} {...props} />
        ))}
      </div>
      {hidden > 0 && (
        <div className="anchor">
          <button
            className="ghost more"
            aria-haspopup="true"
            aria-pressed={moreOpen}
            title="More briefs"
            onClick={() => setMoreOpen((o) => !o)}
            data-testid="brief-more"
          >
            +{hidden}
            <ChevronIcon />
          </button>
          {moreOpen && (
            <BriefList
              {...props}
              onPick={(id) => {
                setMoreOpen(false);
                props.onSwitch(id);
              }}
              onClose={() => setMoreOpen(false)}
            />
          )}
        </div>
      )}
    </nav>
  );
}

function Tab(props: {
  brief: SessionBriefEntry;
  isActive: boolean;
  onSwitch: (sessionId: string) => void;
  onClose: (sessionId: string) => void;
  onFocus: (sessionId: string) => void;
}) {
  const b = props.brief;
  const state = b.isLive ? 'Running in Claude Code' : 'Session ended';
  return (
    <div className="tab" aria-current={props.isActive} data-testid="brief-tab" data-session={b.sessionId}>
      <button
        className="ghost label"
        role="tab"
        aria-selected={props.isActive}
        title={`${b.title}\n${state}${props.isActive && b.isLive ? '\nClick to bring its terminal forward' : ''}`}
        onClick={() => (props.isActive && b.isLive ? props.onFocus(b.sessionId) : props.onSwitch(b.sessionId))}
      >
        <span className={b.isLive ? 'dot live' : 'dot'} aria-label={state} />
        <span className="title">{b.title}</span>
        <ModeChip brief={b} />
        {b.hasContent && (
          <span className="unsent" title="Not sent yet" aria-label="Not sent yet" data-testid="brief-unsent">
            •
          </span>
        )}
      </button>
      <button
        className="ghost icon-button small close"
        aria-label={`Close ${b.title}`}
        title="Close the tab. The board and note stay."
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

/** Every brief, for the ones the row has no room for. */
function BriefList(props: {
  briefs: SessionBriefEntry[];
  activeId?: string;
  home?: string;
  onPick: (sessionId: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { onClose } = props;
  useEffect(() => {
    const outside = (e: MouseEvent) => {
      if (ref.current && !ref.current.parentElement?.contains(e.target as Node)) onClose();
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    document.addEventListener('mousedown', outside);
    window.addEventListener('keydown', escape, { capture: true });
    return () => {
      document.removeEventListener('mousedown', outside);
      window.removeEventListener('keydown', escape, { capture: true });
    };
  }, [onClose]);

  return (
    <div className="popover-panel chooser brief-list" ref={ref} role="dialog" aria-label="All briefs" data-escape-owner data-testid="brief-list">
      <h3>Briefs</h3>
      <ul>
        {props.briefs.map((b) => (
          <li key={b.sessionId}>
            <button
              className="ghost session"
              aria-current={b.sessionId === props.activeId}
              onClick={() => props.onPick(b.sessionId)}
              data-testid="brief-list-item"
            >
              <span className={b.isLive ? 'dot live' : 'dot'} aria-hidden="true" />
              <span className="lines">
                <span>
                  {b.title}
                  {b.hasContent && <span className="unsent"> •</span>}
                  <ModeChip brief={b} />
                </span>
                <span className="muted">{b.cwd ? shortPath(b.cwd, props.home) : b.isLive ? 'Running' : 'Ended'}</span>
              </span>
              <span className="muted when">{ago(b.at)}</span>
              {b.sessionId === props.activeId && <CheckIcon />}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
