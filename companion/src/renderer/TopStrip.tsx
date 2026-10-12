import type { ReactNode } from 'react';
import { clock } from '../voice/timeline';
import { CloseIcon, MicIcon } from './Icons';

/** The right end of the strip: tool icons, then the mic and Send, which never move. */
export function TopStrip(props: {
  /** Icon buttons that sit left of the mic and Send. */
  tools?: ReactNode;
  sendControl: ReactNode;
  recording?: boolean;
  /** How long the current recording has run. */
  elapsedMs?: number;
  /** Saved voice waits for the next Send. */
  hasVoice?: boolean;
  /** Absent in Write mode, which has no mic except while reviewing a page. */
  onMicrophone?: () => void;
  /** The mic's tooltip when it is off. */
  micLabel?: string;
}) {
  return (
    <div className="top">
      {props.tools && <div className="cluster">{props.tools}</div>}
      <div className="cluster send-group">
        {props.onMicrophone && <Mic {...props} />}
        {props.sendControl}
      </div>
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

function Mic(props: { recording?: boolean; elapsedMs?: number; hasVoice?: boolean; onMicrophone?: () => void; micLabel?: string }) {
  if (props.recording) {
    return (
      <button
        className="recording"
        title="Stop recording"
        aria-label="Stop recording"
        aria-pressed="true"
        onClick={props.onMicrophone}
        data-testid="mic"
      >
        <span className="rec-dot" aria-hidden="true" />
        {clock(props.elapsedMs ?? 0)}
      </button>
    );
  }
  const label = props.micLabel ?? (props.hasVoice ? 'Record more voice. Send includes what you recorded.' : 'Record voice');
  return (
    <button
      className="ghost icon-button mic"
      title={label}
      aria-label={label}
      aria-pressed="false"
      onClick={props.onMicrophone}
      data-testid="mic"
    >
      <MicIcon />
      {props.hasVoice && <span className="badge" data-testid="voice-badge" />}
    </button>
  );
}
