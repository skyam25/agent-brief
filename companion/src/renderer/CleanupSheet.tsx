/** Clean up for ended sessions: what they left, what stays and why, and one button that moves the rest to the Trash. */

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CleanupItem, CompanionApi, KeepReason } from '../shared/ipc';
import { useEscape } from './hooks';
import { cleanError } from './ipc-error';

export type CleanupHost = Pick<CompanionApi, 'cleanupPlan' | 'cleanUp'>;

const WHY: Record<KeepReason, string> = {
  git: 'tracked in git',
  initiative: 'in an initiative',
  kept: 'kept by you',
  shared: 'another session holds it',
  open: 'open now',
};

const ORDER: CleanupItem['kind'][] = ['note', 'board', 'feedback', 'items'];

export function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function CleanupSheet(props: {
  host: CleanupHost;
  /** The ended sessions to clean up, with their titles. */
  sessions: { sessionId: string; title: string }[];
  onDone: (text: string) => void;
  onClose: () => void;
}) {
  const [items, setItems] = useState<CleanupItem[]>();
  /** Discard rows you unchecked. Clean up remembers them as kept. */
  const [spared, setSpared] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  useEscape(props.onClose);

  const key = props.sessions.map((s) => s.sessionId).join(' ');
  useEffect(() => {
    let gone = false;
    props.host.cleanupPlan(key.split(' ')).then(
      (plan) => !gone && setItems(plan.sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind))),
      (err) => !gone && setError(cleanError(err)),
    );
    return () => {
      gone = true;
    };
  }, [props.host, key]);

  const many = props.sessions.length > 1;
  const titleOf = (id: string) => props.sessions.find((s) => s.sessionId === id)?.title ?? id;
  const discardable = items?.filter((i) => !i.keep) ?? [];
  const kept = items?.filter((i) => i.keep) ?? [];
  const chosen = discardable.filter((i) => !spared.has(i.id));
  const bytes = chosen.reduce((n, i) => n + i.bytes, 0);
  const total = (items ?? []).reduce((n, i) => n + i.bytes, 0);
  const meta = (i: CleanupItem) => [i.detail, size(i.bytes), many ? titleOf(i.sessionId) : undefined].filter(Boolean).join(' · ');

  const toggle = (id: string) => {
    const next = new Set(spared);
    if (!next.delete(id)) next.add(id);
    setSpared(next);
  };
  const run = async () => {
    setBusy(true);
    try {
      const result = await props.host.cleanUp(chosen.map((i) => i.id), [...spared]);
      props.onDone(result.trashed ? `Moved ${result.trashed} ${result.trashed === 1 ? 'item' : 'items'} (${size(result.bytes)}) to the Trash` : 'Nothing moved to the Trash');
      props.onClose();
    } catch (err) {
      setError(cleanError(err));
      setBusy(false);
    }
  };

  return createPortal(
    <div className="popover-panel cleanup" role="dialog" aria-label="Clean up" data-escape-owner data-testid="cleanup">
      <h2>{many ? `Clean up ${props.sessions.length} ended sessions` : `Clean up · ${props.sessions[0]?.title}`}</h2>
      {items && <p className="muted">{size(total)} left behind. Discarded files go to the Trash.</p>}
      {error && <p className="error">{error}</p>}
      {items?.length === 0 && <p className="muted">Nothing left to clean up.</p>}
      {discardable.length > 0 && (
        <>
          <h3>Discard</h3>
          <ul>
            {discardable.map((i) => (
              <li key={i.id}>
                <label className="cleanup-row" data-testid="cleanup-discard">
                  <input type="checkbox" checked={!spared.has(i.id)} onChange={() => toggle(i.id)} />
                  <span className="lines">
                    <span className="title">{i.label}</span>
                    <span className="muted">{meta(i)}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </>
      )}
      {kept.length > 0 && (
        <>
          <h3>Keeps</h3>
          <ul>
            {kept.map((i) => (
              <li key={i.id} className="cleanup-row" data-testid="cleanup-keep">
                <span className="lines">
                  <span className="title">{i.label}</span>
                  <span className="muted">{[WHY[i.keep!], many ? titleOf(i.sessionId) : undefined].filter(Boolean).join(' · ')}</span>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      {spared.size > 0 && <p className="muted">Unchecked items stay, and later clean ups leave them too.</p>}
      <div className="actions">
        <button className="ghost" onClick={props.onClose}>
          Cancel
        </button>
        <button className="primary" disabled={busy || !items || (!chosen.length && !spared.size)} onClick={() => void run()} data-testid="cleanup-run">
          {chosen.length ? `Move ${size(bytes)} to Trash` : 'Keep these'}
        </button>
      </div>
    </div>,
    document.body,
  );
}
