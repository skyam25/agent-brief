import type { ReactNode } from 'react';
import { clock } from '../voice/timeline';
import { CloseIcon, MicIcon } from './Icons';

export function TopStrip(props: {
  prompt?: string;
  onDismissPrompt: () => void;
  /** Icon buttons that sit left of the mic and Send. */
  tools?: ReactNode;
  /** Send and its target. Hosts without it show `target` and a plain Send button. */
  sendControl?: ReactNode;
  target?: string;
  onSend?: () => void;
  /** The mic button. Hosts without a mic show `voiceNote` instead. */
  recording?: boolean;
  /** How long the current recording has run. */
  elapsedMs?: number;
  /** Saved voice waits for the next Send. */
  hasVoice?: boolean;
  onMicrophone?: () => void;
  voiceNote?: string;
  status?: string;
}) {
  return (
    <div className="top">
      <div className="prompt" data-testid="prompt" title={props.prompt}>
        {props.prompt && (
          <>
            <span>{props.prompt}</span>
            <button className="ghost icon-button small" onClick={props.onDismissPrompt} aria-label="Dismiss">
              <CloseIcon />
            </button>
          </>
        )}
      </div>
      {props.status && <span className="muted status" data-testid="send-status">{props.status}</span>}
      {props.tools && <div className="cluster">{props.tools}</div>}
      {!props.sendControl && props.target && <span className="muted" data-testid="target">{props.target}</span>}
      <div className="cluster send-group">
        {props.onMicrophone ? (
          <Mic {...props} />
        ) : (
          props.voiceNote && <span className="muted" data-testid="voice-note">{props.voiceNote}</span>
        )}
        {props.sendControl ?? (
          <button className="primary" onClick={props.onSend} data-testid="send">
            Send
          </button>
        )}
      </div>
    </div>
  );
}

function Mic(props: { recording?: boolean; elapsedMs?: number; hasVoice?: boolean; onMicrophone?: () => void }) {
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
  const label = props.hasVoice ? 'Record more voice. Send includes what you recorded.' : 'Record voice';
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
