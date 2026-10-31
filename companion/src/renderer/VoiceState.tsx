import type { ReviewVoice } from './review-voice';

/** Says when the mic is on this target, shows words still settling there, or says they are turning into text. */
export function VoiceState(props: { voice: ReviewVoice; target: string }) {
  const listening = props.voice.recording && props.voice.target === props.target;
  const pending = props.voice.pending.has(props.target);
  const settling = props.voice.settling.get(props.target);
  if (!listening && !pending && !settling) return null;
  return (
    <span className="voice-state muted" data-testid="review-voice-state">
      {listening && <span className="rec-dot" aria-hidden="true" />}
      {settling ? (
        <span className="voice-settling" data-testid="review-voice-settling">
          {settling}
        </span>
      ) : pending ? (
        'Writing down what you said…'
      ) : props.voice.starting ? (
        'Starting dictation…'
      ) : (
        'Listening'
      )}
    </span>
  );
}
