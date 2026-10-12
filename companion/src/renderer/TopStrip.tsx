import type { ReactNode } from 'react';
import { CloseIcon } from './Icons';

/** The right end of the strip: utility icons. Send lives in the composer under the work. */
export function TopStrip(props: { tools: ReactNode }) {
  return (
    <div className="top">
      <div className="cluster">{props.tools}</div>
    </div>
  );
}

/** What Claude asked for, on its own row under the strip and tabs. */
export function PromptBanner(props: { prompt?: string; onDismiss: () => void }) {
  if (!props.prompt) return null;
  return (
    <div className="prompt-row" data-testid="prompt" title={props.prompt}>
      <span>{props.prompt}</span>
      <button className="ghost icon-button small" onClick={props.onDismiss} aria-label="Dismiss">
        <CloseIcon />
      </button>
    </div>
  );
}
