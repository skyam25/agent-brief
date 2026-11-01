/** Every session the panel knows, with its boards, searchable by title, folder or board. */

import { useState } from 'react';
import type { BoardEntry, SessionBriefEntry } from '../shared/ipc';
import { boardsOf } from './boardScope';
import { useEscape } from './hooks';
import { BoardIcon, NotesIcon } from './Icons';
import { SessionDot, groupBriefs, whereLine } from './SessionSidebar';

export interface SessionGroup {
  /** Undefined for Unfiled. */
  brief?: SessionBriefEntry;
  title: string;
  where?: string;
  boards: BoardEntry[];
}

/** Unfiled, then running sessions, then ended ones, each with its boards. */
export function sessionGroups(briefs: readonly SessionBriefEntry[], boards: readonly BoardEntry[]): SessionGroup[] {
  const { running, ended } = groupBriefs([...briefs]);
  return [
    { title: 'Unfiled', boards: boardsOf(boards, undefined) },
    ...[...running, ...ended].map((b) => ({ brief: b, title: b.title, where: whereLine(b), boards: boardsOf(boards, b.sessionId) })),
  ];
}

/** A session whose title or folder matches keeps all its boards. Otherwise only its matching boards show. */
export function findSessions(groups: readonly SessionGroup[], query: string): SessionGroup[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...groups];
  return groups.flatMap((g) => {
    if ([g.title, g.where ?? ''].some((t) => t.toLowerCase().includes(q))) return [g];
    const boards = g.boards.filter((b) => b.name.toLowerCase().includes(q));
    return boards.length ? [{ ...g, boards }] : [];
  });
}

export function AllSessions(props: {
  briefs: SessionBriefEntry[];
  boards: BoardEntry[];
  activeId?: string;
  onSwitch: (sessionId: string) => void;
  onUnfiled: () => void;
  onOpenBoard: (board: BoardEntry) => void;
  onCleanUp: (ended: SessionBriefEntry[]) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  useEscape(props.onClose);
  const groups = findSessions(sessionGroups(props.briefs, props.boards), query);
  const ended = groupBriefs(props.briefs).ended;
  const done = (fn: () => void) => () => {
    props.onClose();
    fn();
  };

  return (
    <div className="popover-panel cleanup all-sessions" role="dialog" aria-label="All sessions" data-escape-owner data-testid="all-sessions-sheet">
      <h2>All sessions</h2>
      <input
        type="search"
        autoFocus
        placeholder="Find a session or board"
        aria-label="Find a session or board"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        data-testid="all-sessions-find"
      />
      {groups.length === 0 && <p className="muted">No session or board matches.</p>}
      <ul>
        {groups.map((g) => (
          <li key={g.brief?.sessionId ?? 'unfiled'} className="session-entry" data-testid="all-sessions-row">
            <button
              className="ghost session"
              aria-current={g.brief?.sessionId === props.activeId}
              onClick={done(() => (g.brief ? props.onSwitch(g.brief.sessionId) : props.onUnfiled()))}
            >
              {g.brief ? <SessionDot brief={g.brief} /> : <NotesIcon />}
              <span className="lines">
                <span className="title">{g.title}</span>
                {g.where && <span className="muted">{g.where}</span>}
              </span>
            </button>
            {g.boards.length > 0 && (
              <div className="board-chips">
                {g.boards.map((b) => (
                  <button key={b.name} className="ghost small board" data-done={!!b.done} title={`Open ${b.name}`} onClick={done(() => props.onOpenBoard(b))} data-testid="all-sessions-board">
                    <BoardIcon />
                    {b.name}
                  </button>
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>
      <div className="actions">
        {ended.length > 0 && (
          <button className="ghost" title="Move what the ended sessions left behind to the Trash" onClick={done(() => props.onCleanUp(ended))} data-testid="ended-cleanup">
            Clean up ended sessions…
          </button>
        )}
        <button className="ghost" onClick={props.onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
