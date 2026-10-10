import type { ReactNode } from 'react';
import { clock } from '../voice/timeline';
import { MicIcon } from './Icons';

export function TopStrip(props: {
  prompt?: string;
  onDismissPrompt: () => void;
  /** Send and its target. Hosts without it show `target` and a plain Send button. */
  sendControl?: ReactNode;
  target?: string;
  onSend?: () => void;
  /** The mic button. Hosts without a mic show `voiceNote` instead. */
  recording?: boolean;
  /** How long the current recording has run. */
  elapsedMs?: number;
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
            <button className="ghost small" onClick={props.onDismissPrompt} aria-label="Dismiss">
              ×
            </button>
          </>
        )}
      </div>
      {props.status && <span className="muted status" data-testid="send-status">{props.status}</span>}
      {!props.sendControl && props.target && <span className="muted" data-testid="target">{props.target}</span>}
      {props.onMicrophone ? (
        <button
          className={props.recording ? 'ghost recording' : 'ghost icon-button'}
          title={props.recording ? 'Stop recording' : 'Record voice'}
          aria-label={props.recording ? 'Stop recording' : 'Record voice'}
          aria-pressed={!!props.recording}
          onClick={props.onMicrophone}
          data-testid="mic"
        >
          {props.recording ? `● ${clock(props.elapsedMs ?? 0)}` : <MicIcon />}
        </button>
      ) : (
        props.voiceNote && <span className="muted" data-testid="voice-note">{props.voiceNote}</span>
      )}
      {props.sendControl ?? (
        <button className="primary" onClick={props.onSend} data-testid="send">
          Send
        </button>
      )}
    </div>
  );
}
