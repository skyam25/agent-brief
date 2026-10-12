import { useEffect, useRef, useState } from 'react';
import type { Launcher, LaunchOptions, SessionBriefEntry } from '../shared/ipc';
import { hostLabel, isGhostty } from '../shared/sessions';
import { ChevronIcon } from './Icons';
import { LAUNCHER_LABELS } from './SendTo';
import { useEscape, usePointerOutside } from './hooks';

const openLabel = (l: Launcher) => (l === 'copy' ? LAUNCHER_LABELS.copy : `Open in ${LAUNCHER_LABELS[l]}`);

/** The launcher the session ran in, when this Mac has it, else the first terminal. */
export function preferredLauncher(brief: Pick<SessionBriefEntry, 'host'>, launchers: Launcher[]): Launcher | undefined {
  const host = brief.host;
  const ran: Launcher | undefined = host?.herdrPane ? 'herdr' : isGhostty(host) ? 'ghostty' : host?.terminal === 'Apple_Terminal' ? 'terminal' : undefined;
  if (ran && launchers.includes(ran)) return ran;
  return launchers.find((l) => l !== 'copy') ?? launchers[0];
}

/**
 * Under the tab row while an ended session's tab is active: its state, the
 * command that resumes it, Copy, and Open in a terminal.
 */
export function ResumeRow(props: {
  brief: SessionBriefEntry;
  loadOptions: () => Promise<LaunchOptions>;
  /** Copy is the `copy` launcher. Main puts the command on the clipboard. */
  onResume: (via: Launcher) => void;
}) {
  const { brief } = props;
  const [launchers, setLaunchers] = useState<Launcher[]>([]);
  const [moreOpen, setMoreOpen] = useState(false);

  useEffect(() => {
    void props.loadOptions().then((o) => setLaunchers(o.launchers));
    // Loads once per tab; the key in App remounts the row for another session.
  }, []);

  const ran = hostLabel(brief.host);
  const state = ran ? `Session ended · ran in ${ran}` : 'Session ended';
  const first = preferredLauncher(brief, launchers);
  const others = launchers.filter((l) => l !== first);

  return (
    <div className="resume-row" role="status" data-testid="resume-row">
      <span className="dot" aria-hidden="true" />
      <span className="state">{state}</span>
      {brief.resume ? (
        <>
          <code className="command" title={brief.resume} data-testid="resume-command">
            {brief.resume}
          </code>
          <button className="ghost small" onClick={() => props.onResume('copy')} data-testid="resume-copy">
            Copy
          </button>
          {first && (
            <div className="anchor">
              <div className="split-button">
                <button className="small" onClick={() => props.onResume(first)} data-testid={`resume-open-${first}`}>
                  {openLabel(first)}
                </button>
                {others.length > 0 && (
                  <button
                    className="small icon-button"
                    aria-label="Open somewhere else"
                    title="Open somewhere else"
                    aria-haspopup="menu"
                    aria-pressed={moreOpen}
                    onClick={() => setMoreOpen((o) => !o)}
                    data-testid="resume-more"
                  >
                    <ChevronIcon />
                  </button>
                )}
              </div>
              {moreOpen && (
                <LauncherMenu
                  launchers={others}
                  onPick={(l) => {
                    setMoreOpen(false);
                    props.onResume(l);
                  }}
                  onClose={() => setMoreOpen(false)}
                />
              )}
            </div>
          )}
        </>
      ) : (
        <span className="muted">Its folder is unknown, so it cannot resume from here.</span>
      )}
    </div>
  );
}

function LauncherMenu(props: { launchers: Launcher[]; onPick: (l: Launcher) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const { onClose } = props;
  usePointerOutside(ref, onClose, { parent: true });
  useEscape(onClose);
  return (
    <div className="popover-panel resume-menu" ref={ref} role="menu" aria-label="Open in" data-escape-owner>
      <ul className="launch-more">
        {props.launchers.map((l) => (
          <li key={l}>
            <button className="ghost" role="menuitem" onClick={() => props.onPick(l)} data-testid={`resume-open-${l}`}>
              {openLabel(l)}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
