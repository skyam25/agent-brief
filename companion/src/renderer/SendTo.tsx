import { useEffect, useRef, useState } from 'react';
import type { SessionsResponse } from '../protocol';
import type { Launcher, LaunchOptions } from '../shared/ipc';
import { folderName, sessionTitle, shortPath } from '../shared/sessions';
import { CheckIcon, ChevronIcon, TerminalIcon } from './Icons';

const LAUNCHER_LABELS: Record<Launcher, string> = {
  ghostty: 'Ghostty',
  terminal: 'Terminal',
  herdr: 'herdr',
  copy: 'Copy command',
};

/**
 * Send and where it goes. With a target, a chip names the session and brings
 * its terminal forward. Without one, Send asks where to go first.
 */
export function SendTo(props: {
  sessions: SessionsResponse;
  home?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSend: () => void;
  onSendTo: (sessionId: string) => void;
  onSendNew: (cwd: string, via: Launcher) => void;
  onFocus: (sessionId: string) => void;
  loadOptions: () => Promise<LaunchOptions>;
  chooseFolder: () => Promise<string | undefined>;
}) {
  const target = props.sessions.sessions.find((s) => s.sessionId === props.sessions.targetSessionId);
  return (
    <div className="anchor send-to">
      {target ? (
        <>
          <button
            className="ghost chip"
            title={`${target.cwd}\nBring this session's terminal forward`}
            onClick={() => props.onFocus(target.sessionId)}
            data-testid="target-chip"
          >
            <span>→ {sessionTitle(target)}</span>
            {target.summary && <span className="muted">{target.summary}</span>}
          </button>
          <button className="primary" onClick={props.onSend} data-testid="send">
            Send
          </button>
          <button
            className="ghost icon-button"
            aria-label="Send somewhere else"
            title="Send somewhere else"
            aria-pressed={props.open}
            onClick={() => props.onOpenChange(!props.open)}
            data-testid="send-menu"
          >
            <ChevronIcon />
          </button>
        </>
      ) : (
        <button
          className="primary"
          aria-pressed={props.open}
          onClick={() => props.onOpenChange(!props.open)}
          data-testid="send"
        >
          Send to…
        </button>
      )}
      {props.open && <Chooser {...props} onClose={() => props.onOpenChange(false)} />}
    </div>
  );
}

function Chooser(props: Parameters<typeof SendTo>[0] & { onClose: () => void }) {
  const [options, setOptions] = useState<LaunchOptions>();
  const [folder, setFolder] = useState('');
  const [extra, setExtra] = useState<string[]>([]);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void props.loadOptions().then((o) => {
      setOptions(o);
      setFolder((f) => f || o.recentProjects[0] || '');
    });
    // Loads once each time the chooser opens.
  }, []);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const anchor = ref.current?.parentElement;
      if (anchor && !anchor.contains(e.target as Node)) props.onClose();
    };
    window.addEventListener('pointerdown', onDown, { capture: true });
    return () => window.removeEventListener('pointerdown', onDown, { capture: true });
  }, [props.onClose]);

  const choose = async () => {
    const picked = await props.chooseFolder();
    if (!picked) return;
    setExtra((x) => (x.includes(picked) ? x : [picked, ...x]));
    setFolder(picked);
  };

  const folders = [...new Set([...extra, ...(options?.recentProjects ?? [])])];
  const sessions = props.sessions.sessions;
  const [first, ...others] = options?.launchers ?? [];

  return (
    <div className="popover-panel chooser" ref={ref} role="dialog" aria-label="Send to" data-testid="send-chooser">
      <h3>Running sessions</h3>
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
                <span className="avatar" aria-hidden="true">
                  {folderName(s.cwd).charAt(0).toUpperCase() || <TerminalIcon />}
                </span>
                <span className="lines">
                  <span>{sessionTitle(s)}</span>
                  <span className="muted">{s.summary ?? shortPath(s.cwd, props.home)}</span>
                </span>
                {s.sessionId === props.sessions.targetSessionId && <CheckIcon />}
              </button>
            </li>
          ))}
        </ul>
      )}
      <h3>New session</h3>
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
              {folderName(f)} — {shortPath(f, props.home)}
            </option>
          ))}
        </select>
        <button onClick={() => void choose()} data-testid="new-choose">
          Choose…
        </button>
      </div>
      {first && (
        <div className="row launchers">
          <button className="primary" disabled={!folder} onClick={() => props.onSendNew(folder, first)} data-testid={`new-${first}`}>
            {first === 'copy' ? LAUNCHER_LABELS.copy : `Start in ${LAUNCHER_LABELS[first]}`}
          </button>
          {others.length > 0 && <span className="muted">or</span>}
          {others.map((l) => (
            <button key={l} className="ghost link" disabled={!folder} onClick={() => props.onSendNew(folder, l)} data-testid={`new-${l}`}>
              {LAUNCHER_LABELS[l]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
