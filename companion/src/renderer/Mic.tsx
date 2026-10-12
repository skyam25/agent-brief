import { clock } from '../voice/timeline';
import { MicIcon } from './Icons';

/** The composer's mic: an icon while off, the running clock while recording. */
export function Mic(props: { recording?: boolean; elapsedMs?: number; hasVoice?: boolean; onMicrophone: () => void; micLabel?: string }) {
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
