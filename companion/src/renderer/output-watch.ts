import { useEffect, useRef } from 'react';
import type { CompanionApi } from '../shared/ipc';

export type OutputWatchHost = Pick<CompanionApi, 'watchOutput' | 'unwatchOutput' | 'onOutputChanged'>;

/**
 * Main watches the output and its feedback file while the view shows.
 * Outside edits to the feedback file arrive as `feedback:changed`, and to the output through `onChange`.
 */
export function useOutputWatch(host: OutputWatchHost, sessionId: string | undefined, path: string, onChange?: () => void): void {
  const changed = useRef(onChange);
  changed.current = onChange;
  useEffect(() => {
    if (!sessionId) return;
    // A path main refuses goes unwatched. Refresh still reads it.
    void host.watchOutput(sessionId, path).catch(() => undefined);
    const off = host.onOutputChanged((c) => {
      if (c.sessionId === sessionId && c.path === path) changed.current?.();
    });
    return () => {
      off();
      void host.unwatchOutput(sessionId, path).catch(() => undefined);
    };
  }, [host, sessionId, path]);
}
