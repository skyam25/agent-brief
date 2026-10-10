import { useEffect, useRef, useState } from 'react';
import type { Settings } from '../shared/ipc';

/** Hotkey, delivery mode and launch at login. `onChange` returns an error message when a change is refused. */
export function SettingsPopover(props: {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => Promise<string | undefined>;
  onClose: () => void;
}) {
  const [hotkey, setHotkey] = useState(props.settings.hotkey);
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
    </div>
  );
}
