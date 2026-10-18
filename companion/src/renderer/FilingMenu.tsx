import { useState } from 'react';
import type { Draft, SessionBriefEntry } from '../shared/ipc';
import { CheckIcon, ChevronIcon } from './Icons';

/** A session tab, as the filing list names it. `where` tells apart tabs that share a title. */
export type FilingTab = Pick<SessionBriefEntry, 'sessionId' | 'title'> & { where?: string };

/** The session tab a draft is filed under, or undefined when it shows on Unfiled. */
export const filedTab = (d: Draft, tabs: FilingTab[]) => tabs.find((t) => t.sessionId === d.sessionId);

/** The session tabs, then Unfiled, with the one the item is filed under checked. */
export function FilingList(props: {
  tabs: FilingTab[];
  /** The session the item is filed under. Undefined means Unfiled. */
  filed: string | undefined;
  onFile: (sessionId: string | undefined) => void;
}) {
  const filed = props.tabs.find((t) => t.sessionId === props.filed)?.sessionId;
  const item = (sessionId: string | undefined, label: string, where?: string) => (
    <button
      key={sessionId ?? ''}
      className="ghost"
      role="menuitemradio"
      aria-checked={filed === sessionId}
      title={where ? `${label}\n${where}` : label}
      onClick={() => props.onFile(sessionId)}
      data-testid="file-under"
      data-session={sessionId ?? ''}
    >
      <span className="label-text">
        {label}
        {where && <span className="where">{where}</span>}
      </span>
      {filed === sessionId && <CheckIcon />}
    </button>
  );
  return (
    <div className="filing-list" role="group" aria-label="File under">
      {props.tabs.map((t) => item(t.sessionId, t.title, t.where))}
      {item(undefined, 'Unfiled')}
    </div>
  );
}

/**
 * "File under…" in a ⋯ menu. It opens the filing list in place, with the
 * item's current tab checked.
 */
export function FileUnder(props: {
  /** The session the item is filed under. Undefined means Unfiled. */
  filed: string | undefined;
  tabs: FilingTab[];
  onFile: (sessionId: string | undefined) => void;
  /** The list opened. */
  onOpen?: () => void;
  /** Closes the ⋯ menu. */
  close: () => void;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const filed = props.tabs.find((t) => t.sessionId === props.filed);
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
        data-testid={props.testId ?? 'draft-file-under'}
      >
        <span className="label-text">File under…</span>
        <ChevronIcon />
      </button>
      {open && (
        <FilingList
          tabs={props.tabs}
          filed={props.filed}
          onFile={(sessionId) => {
            props.close();
            props.onFile(sessionId);
          }}
        />
      )}
    </>
  );
}
