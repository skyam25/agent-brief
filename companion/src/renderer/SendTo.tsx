import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { SessionsResponse } from '../protocol';
import type { Launcher, LaunchOptions } from '../shared/ipc';
import type { SessionInfo } from '../protocol';
import type { DecisionsClaim } from './decisions-send';
import { activeAgo, folderName, hostLabel, hueOf, shortFolder } from '../shared/sessions';
import { CheckIcon, ChevronIcon, TerminalIcon } from './Icons';
import { usePointerOutside } from './hooks';

export const LAUNCHER_LABELS: Record<Launcher, string> = {
  ghostty: 'Ghostty',
  terminal: 'Terminal',
  herdr: 'herdr',
  copy: 'Copy command',
};

const launchLabel = (l: Launcher) => (l === 'copy' ? LAUNCHER_LABELS.copy : `Start in ${LAUNCHER_LABELS[l]}`);

/**
 * The composer's right end: the mic, then Send. The breadcrumb names a live
 * target, so Send carries its name in a tooltip. Without a live target, a
 * "Send to…" chip opens the chooser, and Send opens it too.
 */
export function SendTo(props: {
  sessions: SessionsResponse;
  home?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSend: () => void;
  onSendTo: (sessionId: string) => void;
  onSendNew: (cwd: string, via: Launcher) => void;
  /** Saves the files in a folder and copies a prompt to paste into a session by hand. */
  onCopyPrompt: (cwd: string) => void;
  /** The session whose brief holds the open board or note. */
  holder?: string;
  /** The holder's folder, kept in its brief after the session ends. */
  holderCwd?: string;
  /** What the open item is, for the holder's tag. */
  holds: 'board' | 'note';
  loadOptions: () => Promise<LaunchOptions>;
  loadPlaces: () => Promise<Record<string, string>>;
  chooseFolder: () => Promise<string | undefined>;
  /** Sits before the chip and Send, set apart by a divider. */
  mic?: ReactNode;
  /** A Feedback view's decisions, which Send hands its own session in place of the chooser. */
  decisions?: DecisionsClaim;
}) {
  const target = props.sessions.sessions.find((s) => s.sessionId === props.sessions.targetSessionId);
  const name = target && (target.title || folderName(target.cwd));
  const d = props.decisions;
  if (d) {
    return (
      <div className="anchor send-to">
        {props.mic && (
          <>
            {props.mic}
            <span className="divider" aria-hidden="true" />
          </>
        )}
        <button
          className="primary send-named"
          disabled={!!d.blocked || !d.count}
          title={d.blocked ?? (d.count ? 'Hand Claude what you decided since the last send' : 'Decide something first')}
          onClick={d.send}
          data-testid="send"
        >
          Send decisions{d.count ? ` · ${d.count}` : ''}
        </button>
      </div>
    );
  }
  return (
    <div className="anchor send-to">
      {props.mic && (
        <>
          {props.mic}
          <span className="divider" aria-hidden="true" />
        </>
      )}
      {!target && (
        <button
          className="ghost send-target"
          title="Choose a session to send to"
          aria-haspopup="dialog"
          aria-pressed={props.open}
          onClick={() => props.onOpenChange(!props.open)}
          data-testid="send-menu"
        >
          <span className="dot" aria-hidden="true" />
          <span className="name">Send to…</span>
          <ChevronIcon />
        </button>
      )}
      <button
        className="primary send-named"
        title={target ? `Send to ${name}` : 'Choose a session to send to'}
        aria-haspopup={target ? undefined : 'dialog'}
        onClick={target ? props.onSend : () => props.onOpenChange(!props.open)}
        data-testid="send"
      >
        Send
      </button>
      {props.open && <Chooser {...props} onClose={() => props.onOpenChange(false)} />}
    </div>
  );
}

function Chooser(props: Parameters<typeof SendTo>[0] & { onClose: () => void }) {
  const [options, setOptions] = useState<LaunchOptions>();
  const [places, setPlaces] = useState<Record<string, string>>({});
  const [folder, setFolder] = useState('');
  const [extra, setExtra] = useState<string[]>([]);
  const [launchMore, setLaunchMore] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const held = props.sessions.sessions.find((s) => s.sessionId === props.holder)?.cwd ?? props.holderCwd;
    void props.loadOptions().then((o) => {
      setOptions(o);
      setFolder((f) => f || held || o.recentProjects[0] || '');
    });
    void props.loadPlaces().then(setPlaces, () => undefined);
    // Loads once each time the chooser opens.
  }, []);

  usePointerOutside(ref, props.onClose, { parent: true });

  const choose = async () => {
    const picked = await props.chooseFolder();
    if (!picked) return;
    setExtra((x) => (x.includes(picked) ? x : [picked, ...x]));
    setFolder(picked);
  };

  const folders = [...new Set([...extra, ...(folder ? [folder] : []), ...(options?.recentProjects ?? [])])];
  const sessions = byRelevance(props.sessions.sessions, props.holder);
  const now = Date.now();
  const [first, ...others] = options?.launchers ?? [];

  return (
    <div className="popover-panel chooser" ref={ref} role="dialog" aria-label="Send to" data-testid="send-chooser">
      <h3>Running</h3>
      {sessions.length === 0 ? (
        <p className="muted">No Claude Code session has the companion open. Start one below, or run /sketch in one.</p>
      ) : (
        <ul>
          {sessions.map((s) => (
            <li key={s.sessionId}>
              <button
                className="ghost session"
                title={s.cwd}
                aria-current={s.sessionId === props.sessions.targetSessionId}
                onClick={() => props.onSendTo(s.sessionId)}
                data-testid="send-to-session"
              >
                <span className="avatar" aria-hidden="true" style={{ '--hue': hueOf(s.sessionId) } as CSSProperties}>
                  {(s.title || folderName(s.cwd)).charAt(0).toUpperCase() || <TerminalIcon />}
                </span>
                <span className="lines">
                  <span className="name">
                    <span>{[s.title || folderName(s.cwd), places[s.sessionId] ?? hostLabel(s.host)].filter(Boolean).join(' · ')}</span>
                    {s.sessionId === props.holder && (
                      <span className="holds" data-testid="send-holder">
                        Has this {props.holds}
                      </span>
                    )}
                  </span>
                  {s.summary && <span className="muted">“{s.summary}”</span>}
                  <span className="muted small">
                    {[shortFolder(s.cwd, props.home), s.activeAt ? activeAgo(s.activeAt, now) : undefined].filter(Boolean).join(' · ')}
                  </span>
                </span>
                {s.sessionId === props.sessions.targetSessionId && <CheckIcon />}
              </button>
            </li>
          ))}
        </ul>
      )}
      <h3>Somewhere else</h3>
      <div className="row">
        <select
          value={folder}
          onChange={(e) => setFolder(e.target.value)}
          aria-label="Project folder"
          data-testid="new-folder"
        >
          {folders.length === 0 && <option value="">No recent folders</option>}
          {folders.map((f) => (
            <option key={f} value={f} title={f}>
              {folderName(f)} — {shortFolder(f, props.home)}
            </option>
          ))}
        </select>
        <button onClick={() => void choose()} data-testid="new-choose">
          Choose…
        </button>
      </div>
      {first && (
        <div className="launchers">
          <div className="launch-row">
          <div className="split-button">
            <button className="primary" disabled={!folder} onClick={() => props.onSendNew(folder, first)} data-testid={`new-${first}`}>
              {launchLabel(first)}
            </button>
            {others.length > 0 && (
              <button
                className="primary icon-button"
                disabled={!folder}
                aria-label="Start somewhere else"
                title="Start somewhere else"
                aria-pressed={launchMore}
                onClick={() => setLaunchMore((o) => !o)}
                data-testid="new-more"
              >
                <ChevronIcon />
              </button>
            )}
          </div>
          <button
            className="ghost"
            disabled={!folder}
            title="Save the files in this folder and copy a prompt that names them in full, to paste into any session"
            onClick={() => props.onCopyPrompt(folder)}
            data-testid="copy-prompt"
          >
            Copy prompt
          </button>
          </div>
          {launchMore && (
            <ul className="launch-more" role="menu">
              {others.map((l) => (
                <li key={l}>
                  <button className="ghost" role="menuitem" onClick={() => props.onSendNew(folder, l)} data-testid={`new-${l}`}>
                    {launchLabel(l)}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/** The holder first, then the sessions that replied most recently. */
function byRelevance(sessions: SessionInfo[], holder: string | undefined): SessionInfo[] {
  const rank = (s: SessionInfo) => (s.sessionId === holder ? 1 : 0);
  return [...sessions].sort((a, b) => rank(b) - rank(a) || (b.activeAt ?? 0) - (a.activeAt ?? 0));
}
