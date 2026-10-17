import { useState } from 'react';
import type { Draft, SessionBriefEntry } from '../shared/ipc';
import { CheckIcon, ChevronIcon } from './Icons';

/** A session tab, as the filing list names it. */
export type FilingTab = Pick<SessionBriefEntry, 'sessionId' | 'title'>;

/** The session tab a draft is filed under, or undefined when it shows on Unfiled. */
export const filedTab = (d: Draft, tabs: FilingTab[]) => tabs.find((t) => t.sessionId === d.sessionId);

/**
 * "File under…" in the draft's ⋯ menu. It opens a list of session tabs and
 * Unfiled in place, with the draft's current one checked.
 */
export function FileUnder(props: {
  draft: Draft;
  tabs: FilingTab[];
  onFile: (sessionId: string | undefined) => void;
  /** The list opened. */
  onOpen?: () => void;
  /** Closes the ⋯ menu. */
  close: () => void;
}) {
  const [open, setOpen] = useState(false);
  const filed = filedTab(props.draft, props.tabs);
  const item = (sessionId: string | undefined, label: string) => (
    <button
      key={sessionId ?? ''}
      className="ghost"
      role="menuitemradio"
      aria-checked={filed?.sessionId === sessionId}
      onClick={() => {
        props.close();
        props.onFile(sessionId);
      }}
      data-testid="file-under"
      data-session={sessionId ?? ''}
    >
      <span className="label-text">{label}</span>
      {filed?.sessionId === sessionId && <CheckIcon />}
    </button>
  );
  return (
    <>
      <button
        className="ghost file-under-toggle"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        title={filed ? `Filed under ${filed.title}` : 'On Unfiled'}
        onClick={() => {
          if (!open) props.onOpen?.();
          setOpen(!open);
        }}
        data-testid="draft-file-under"
      >
        <span className="label-text">File under…</span>
        <ChevronIcon />
      </button>
      {open && (
        <div className="filing-list" role="group" aria-label="File under">
          {props.tabs.map((t) => item(t.sessionId, t.title))}
          {item(undefined, 'Unfiled')}
        </div>
      )}
    </>
  );
}
