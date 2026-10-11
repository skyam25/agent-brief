import { useEffect, useRef, useState } from 'react';
import type { Settings, UpdateStatus } from '../shared/ipc';

/** What the update line says, or undefined when the version stands alone. */
function updateText(u: UpdateStatus): string | undefined {
  switch (u.state) {
    case 'checking':
      return 'Checking for updates…';
    case 'current':
      return 'Up to date.';
    case 'downloading':
      return `Downloading ${u.available ?? 'the update'}${u.percent ? ` · ${u.percent}%` : ''}…`;
    case 'ready':
      return `Version ${u.available} is ready. It installs when Agent Brief quits.`;
    case 'error':
      return `Could not check for updates: ${u.error}`;
    default:
      return undefined;
  }
}

/** Hotkeys, delivery mode, launch at login and updates. `onChange` returns an error message when a change is refused. */
export function SettingsPopover(props: {
  settings: Settings;
  update?: UpdateStatus;
  onChange: (patch: Partial<Settings>) => Promise<string | undefined>;
  onCheckUpdate: () => void;
  onInstallUpdate: () => void;
  onClose: () => void;
}) {
  const { update } = props;
  const updateLine = update && updateText(update);
  const [hotkey, setHotkey] = useState(props.settings.hotkey);
  const [captureHotkey, setCaptureHotkey] = useState(props.settings.captureHotkey);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const anchor = ref.current?.parentElement;
      if (anchor && !anchor.contains(e.target as Node)) props.onClose();
    };
    window.addEventListener('pointerdown', onDown, { capture: true });
    return () => window.removeEventListener('pointerdown', onDown, { capture: true });
  }, [props]);

  const change = async (patch: Partial<Settings>) => {
    setSaved(false);
    const err = await props.onChange(patch);
    setError(err);
    setSaved(!err);
  };

  return (
    <div className="popover-panel" ref={ref} role="dialog" aria-label="Settings" data-testid="settings">
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          void change({ hotkey });
        }}
      >
        <label htmlFor="hotkey">Show or hide</label>
        <input id="hotkey" data-testid="settings-hotkey" value={hotkey} onChange={(e) => setHotkey(e.target.value)} />
        <button type="submit" data-testid="settings-hotkey-save">
          Set
        </button>
      </form>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          void change({ captureHotkey });
        }}
      >
        <label htmlFor="capture-hotkey">New note</label>
        <input
          id="capture-hotkey"
          data-testid="settings-capture-hotkey"
          value={captureHotkey}
          onChange={(e) => setCaptureHotkey(e.target.value)}
        />
        <button type="submit" data-testid="settings-capture-hotkey-save">
          Set
        </button>
      </form>
      <div className="row">
        <label htmlFor="mode">After Send</label>
        <select
          id="mode"
          data-testid="settings-mode"
          value={props.settings.deliveryMode}
          onChange={(e) => void change({ deliveryMode: e.target.value as Settings['deliveryMode'] })}
        >
          <option value="submit">Send it to Claude at once</option>
          <option value="fill">Put it in the prompt box</option>
        </select>
      </div>
      <label className="row check">
        <input
          type="checkbox"
          data-testid="settings-login"
          checked={props.settings.openAtLogin}
          onChange={(e) => void change({ openAtLogin: e.target.checked })}
        />
        Open at login
      </label>
      {error && (
        <p className="error" role="alert" data-testid="settings-error">
          {error}
        </p>
      )}
      {saved && !error && <p className="muted" data-testid="settings-saved">Saved.</p>}
      {update && (
        <div className="update" data-testid="settings-update">
          <div className="row">
            <span className="muted">Version {update.version}</span>
            {update.state === 'ready' ? (
              <button className="primary" onClick={props.onInstallUpdate} data-testid="settings-update-install">
                Restart to Update
              </button>
            ) : (
              update.state !== 'off' && (
                <button
                  onClick={props.onCheckUpdate}
                  disabled={update.state === 'checking' || update.state === 'downloading'}
                  data-testid="settings-update-check"
                >
                  Check for Updates
                </button>
              )
            )}
          </div>
          {updateLine && (
            <p className={update.state === 'error' ? 'error' : 'muted'} data-testid="settings-update-status">
              {updateLine}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
