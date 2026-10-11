import { useEffect, useRef, useState } from 'react';
import { acceleratorFromPress, acceleratorLabel } from '../shared/accelerator';
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

/** Hotkeys, delivery mode, appearance, launch at login and updates. `onChange` returns an error message when a change is refused. */
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
      <div className="row">
        <span className="label">Show or hide</span>
        <KeyChip value={props.settings.hotkey} onRecord={(hotkey) => void change({ hotkey })} testId="settings-hotkey" />
      </div>
      <div className="row">
        <span className="label">New note</span>
        <KeyChip
          value={props.settings.captureHotkey}
          onRecord={(captureHotkey) => void change({ captureHotkey })}
          testId="settings-capture-hotkey"
        />
      </div>
      <div className="row">
        <label className="label" htmlFor="mode">After Send</label>
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
      <div className="row">
        <label className="label" htmlFor="appearance">Appearance</label>
        <select
          id="appearance"
          data-testid="settings-appearance"
          value={props.settings.appearance}
          onChange={(e) => void change({ appearance: e.target.value as Settings['appearance'] })}
        >
          <option value="system">Match the system</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
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

/**
 * A shortcut as macOS writes it, such as ⌃⌥S. A click starts recording; the
 * next key with a modifier becomes the shortcut, and Escape keeps the old one.
 */
function KeyChip(props: { value: string; onRecord: (accelerator: string) => void; testId: string }) {
  const [recording, setRecording] = useState(false);
  const [hint, setHint] = useState<string>();

  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.metaKey) return setRecording(false);
      const accelerator = acceleratorFromPress(e);
      if (!accelerator) return;
      if (!e.ctrlKey && !e.altKey && !e.metaKey && !/^F\d+$/.test(accelerator)) {
        setHint('Hold ⌃, ⌥ or ⌘ with the key');
        return;
      }
      setRecording(false);
      props.onRecord(accelerator);
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [recording, props.onRecord]);

  return (
    <button
      className={recording ? 'key-chip recording' : 'key-chip'}
      aria-pressed={recording}
      title={recording ? 'Press the new shortcut. Escape keeps this one.' : 'Click, then press a new shortcut'}
      onClick={() => {
        setHint(undefined);
        setRecording((r) => !r);
      }}
      data-escape-owner={recording || undefined}
      data-testid={props.testId}
    >
      {recording ? (hint ?? 'Press keys…') : acceleratorLabel(props.value)}
    </button>
  );
}
