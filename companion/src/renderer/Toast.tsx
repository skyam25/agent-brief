import { useEffect } from 'react';
import { CloseIcon } from './Icons';

/**
 * `progress` stays while work runs, `info` and `sent` leave after a few
 * seconds, and `error` stays until dismissed.
 */
export type ToastKind = 'progress' | 'info' | 'sent' | 'error';

export interface ToastMessage {
  text: string;
  kind: ToastKind;
  /** Bumped on every message, so the same text twice restarts the timer. */
  id: number;
}

export const TOAST_MS = 4000;

/** One message at the bottom of the panel. A successful Send offers History. */
export function Toast(props: { toast?: ToastMessage; onDismiss: () => void; onHistory: () => void }) {
  const { toast, onDismiss } = props;

  useEffect(() => {
    if (!toast || toast.kind === 'progress' || toast.kind === 'error') return;
    const timer = setTimeout(onDismiss, TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast, onDismiss]);

  if (!toast) return null;
  return (
    <div className={`toast ${toast.kind}`} role={toast.kind === 'error' ? 'alert' : 'status'}>
      <span className="text" data-testid="send-status">
        {toast.text}
      </span>
      {toast.kind === 'sent' && (
        <button className="ghost small link" onClick={props.onHistory} data-testid="toast-history">
          View in History
        </button>
      )}
      {toast.kind !== 'progress' && (
        <button className="ghost icon-button small" aria-label="Dismiss" onClick={onDismiss} data-testid="toast-dismiss">
          <CloseIcon />
        </button>
      )}
    </div>
  );
}
