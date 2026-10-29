import { useEffect, useState } from 'react';
import { clock } from '../voice/timeline';
import { CloseIcon, MicIcon } from './Icons';

/** The in-panel shortcut that starts and stops talking. */
export const TALK_KEY = '⌥T';

const BARS = 28;

/** The composer's voice button: Talk and annotate on the board or a note, Talk through page in a review, Discard and Stop while recording. */
export function Mic(props: {
  recording?: boolean;
  /** The mic talks to the board's pins, not a page's. */
  board?: boolean;
  /** The mic talks to a note's comments. */
  note?: boolean;
  onMicrophone: () => void;
  onDiscard?: () => void;
}) {
  if (props.recording) {
    return (
      <>
        {props.onDiscard && (
          <button className="ghost" title="Discard what you recorded" onClick={props.onDiscard} data-testid="voice-discard">
            <CloseIcon />
            Discard
          </button>
        )}
        <button className="stop-talk" title={`Stop (${TALK_KEY})`} aria-pressed="true" onClick={props.onMicrophone} data-testid="mic">
          <span className="stop-square" aria-hidden="true" />
          Stop
        </button>
      </>
    );
  }
  const label = props.board || props.note ? 'Talk and annotate' : 'Talk through page';
  const title = props.board
    ? 'Talk and click the board to pin comments. Each pin gets what you say after it.'
    : props.note
      ? 'Talk and select passages to comment on them. Each comment gets what you say after it.'
      : 'Talk through the page. Each pin gets what you say after it.';
  return (
    <button className="talk" title={`${title} (${TALK_KEY})`} aria-pressed="false" onClick={props.onMicrophone} data-testid="mic">
      <MicIcon />
      <span className="talk-label">{label}</span>
      <kbd>{TALK_KEY}</kbd>
    </button>
  );
}

/** The composer's left side: the live clock and level while recording, then the take waiting for Send. */
export function VoiceStrip(props: {
  recording?: boolean;
  reviewing?: boolean;
  /** The mic is open but dictation does not hear it yet. */
  starting?: boolean;
  /** Epoch ms when the microphone opened. */
  since?: number;
  voiceMs: number;
  hasVoice?: boolean;
  input?: MediaStream;
  onDiscard?: () => void;
}) {
  if (props.recording) {
    return (
      <div className="voice-strip" data-testid="voice-strip">
        <RecClock since={props.since} earlierMs={props.reviewing ? 0 : props.voiceMs} />
        {props.input && <LevelMeter stream={props.input} />}
        <span className="muted hint">
          {props.starting ? 'Starting dictation…' : props.reviewing ? 'Listening. Words go to the selected pin.' : 'Listening. Keep sketching.'}
        </span>
      </div>
    );
  }
  if (!props.hasVoice || props.reviewing) return <div className="voice-strip" />;
  return (
    <div className="voice-strip">
      <span className="voice-take" data-testid="voice-take">
        <MicIcon />
        {clock(props.voiceMs)} recorded
        {props.onDiscard && (
          <button className="ghost icon-button small" title="Discard what you recorded" aria-label="Discard what you recorded" onClick={props.onDiscard} data-testid="voice-take-discard">
            <CloseIcon />
          </button>
        )}
      </span>
    </div>
  );
}

/** The recording clock. It ticks here, so the rest of the panel and the board never re-render with it. */
function RecClock({ since, earlierMs }: { since?: number; earlierMs: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, []);
  const elapsedMs = since === undefined ? 0 : earlierMs + Math.max(0, now - since);
  return (
    <span className="rec-clock" data-testid="mic-clock">
      <span className="rec-dot" aria-hidden="true" />
      {clock(elapsedMs)}
    </span>
  );
}

/** Recent microphone loudness as a row of bars, newest on the right. */
function LevelMeter({ stream }: { stream: MediaStream }) {
  const [levels, setLevels] = useState<number[]>(() => Array(BARS).fill(0));
  useEffect(() => {
    // No output device. Opening one during a call can switch a headset's audio route.
    const ctx = new AudioContext({ sinkId: { type: 'none' } } as AudioContextOptions);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    const timer = setInterval(() => {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const v of samples) sum += v * v;

      // Square root of RMS spreads quiet speech across the bar height.
      const level = Math.min(1, Math.sqrt(Math.sqrt(sum / samples.length)) * 2);
      setLevels((l) => [...l.slice(1), level]);
    }, 80);
    return () => {
      clearInterval(timer);
      void ctx.close();
    };
  }, [stream]);
  return (
    <span className="level-meter" aria-hidden="true" data-testid="level-meter">
      {levels.map((l, i) => (
        <span key={i} style={{ height: `${Math.round(3 + l * 21)}px` }} />
      ))}
    </span>
  );
}
