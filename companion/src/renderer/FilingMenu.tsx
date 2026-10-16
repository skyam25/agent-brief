import type { Draft, SessionBriefEntry } from '../shared/ipc';
import { FooterMenu } from './FooterMenu';
import { CheckIcon, ChevronIcon } from './Icons';

/** A session tab, as the filing menu names it. */
export type FilingTab = Pick<SessionBriefEntry, 'sessionId' | 'title'>;

/** The session tab a draft is filed under, or undefined when it shows on the Notes tab. */
export const filedTab = (d: Draft, tabs: FilingTab[]) => tabs.find((t) => t.sessionId === d.sessionId);

/** The session a draft is filed under, as a chip whose menu files it elsewhere. */
export function FilingMenu(props: { draft: Draft; tabs: FilingTab[]; onFile: (sessionId: string | undefined) => void; onOpen?: () => void }) {
  const filed = filedTab(props.draft, props.tabs);
  const item = (sessionId: string | undefined, label: string, close: () => void) => (
    <button
      key={sessionId ?? ''}
      className="ghost"
      role="menuitemradio"
      aria-checked={filed?.sessionId === sessionId}
      onClick={() => {
        close();
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
    <FooterMenu
      className="filing-menu"
      trigger={(open, toggle) => (
        <button
          className={filed ? 'chip filing filed' : 'chip filing unset'}
          aria-haspopup="menu"
          aria-pressed={open}
          title={filed ? `Filed under ${filed.title}. Click to file it elsewhere.` : 'On the Notes tab. Click to file it under a session.'}
          onClick={() => {
            if (!open) props.onOpen?.();
            toggle();
          }}
          data-testid="draft-filing"
        >
          <span className="label-text">{filed?.title ?? 'File under'}</span>
          <ChevronIcon />
        </button>
      )}
    >
      {(close) => (
        <>
          <h3>File under</h3>
          {props.tabs.map((t) => item(t.sessionId, t.title, close))}
          {item(undefined, 'Unfiled', close)}
        </>
      )}
    </FooterMenu>
  );
}
