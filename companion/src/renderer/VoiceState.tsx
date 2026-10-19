import type { ReviewVoice } from './review-voice';

/** Says when the mic is on this target, or its words are still turning into text. */
export function VoiceState(props: { voice: ReviewVoice; target: string }) {
  const listening = props.voice.recording && props.voice.target === props.target;
  const pending = props.voice.pending.has(props.target);
  if (!listening && !pending) return null;
  return (
    <span className="voice-state muted" data-testid="review-voice-state">
      {listening && <span className="rec-dot" aria-hidden="true" />}
      {pending ? 'Writing down what you said…' : 'Listening'}
    </span>
  );
}
