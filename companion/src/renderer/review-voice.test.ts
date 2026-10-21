import { describe, expect, it } from 'vitest';
import { OVERALL, ReviewVoice, type LiveDictation, type VoiceMedia } from './review-voice';

/** A fake microphone whose clips hold the clock time they started at. `delay` sets how long each clip takes to transcribe. */
function setup(delay: (clip: string) => number = () => 0) {
  let t = 0;
  const heard: [string, string][] = [];
  const errors: string[] = [];
  let open = 0;
  const media: VoiceMedia = {
    open: async () => {
      open++;
      return {} as MediaStream;
    },
    record: () => {
      const startedAt = t;
      return { stop: async () => ({ data: new TextEncoder().encode(`clip@${startedAt}`), mimeType: 'audio/webm' }) };
    },
    close: () => open--,
  };
  const voice = new ReviewVoice({
    media,
    now: () => t,
    transcribe: (clip) => {
      const text = new TextDecoder().decode(clip.data);
      return new Promise((r) => setTimeout(() => r({ text }), delay(text)));
    },
    onText: (target, text) => heard.push([target, text]),
    onError: (m) => errors.push(m),
  });
  return { voice, heard, errors, tick: (ms: number) => (t += ms), isOpen: () => open > 0 };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('ReviewVoice', () => {
  it('sends each clip to the target it was recorded for', async () => {
    const { voice, heard, tick, isOpen } = setup();
    await voice.start(OVERALL);
    expect(isOpen()).toBe(true);
    tick(2000);
    voice.aim('c1');
    tick(3000);
    voice.aim('c2');
    tick(1500);
    await voice.stop();
    await settle();
    expect(isOpen()).toBe(false);
    expect(heard).toEqual([
      [OVERALL, 'clip@0'],
      ['c1', 'clip@2000'],
      ['c2', 'clip@5000'],
    ]);
    expect(voice.pending.size).toBe(0);
  });

  it('drops clips too short to hold words', async () => {
    const { voice, heard, tick } = setup();
    await voice.start('c1');
    tick(300);
    voice.aim('c2');
    tick(1000);
    await voice.stop();
    await settle();
    expect(heard).toEqual([['c2', 'clip@300']]);
  });

  it('waits on stop for an earlier clip that transcribes slower than the last', async () => {
    const { voice, heard, tick } = setup((clip) => (clip === 'clip@0' ? 30 : 0));
    await voice.start('c1');
    tick(20000);
    voice.aim('c2');
    tick(1500);
    await voice.stop();
    expect(heard).toEqual([
      ['c2', 'clip@20000'],
      ['c1', 'clip@0'],
    ]);
  });

  it('waits for clips still transcribing when the microphone is already off', async () => {
    const { voice, heard, tick } = setup(() => 30);
    await voice.start('c1');
    tick(1000);
    void voice.stop();
    expect(heard).toEqual([]);
    await voice.stop();
    expect(heard).toEqual([['c1', 'clip@0']]);
  });

  it('only moves the target while the microphone is off', async () => {
    const { voice, heard } = setup();
    voice.aim('c3');
    expect(voice.target).toBe('c3');
    expect(voice.recording).toBe(false);
    await settle();
    expect(heard).toEqual([]);
  });

  it('passes on a transcription error', async () => {
    const { voice, errors, tick } = setup();
    (voice as any).opts.transcribe = async () => ({ error: 'yap not found' });
    await voice.start('c1');
    tick(1000);
    await voice.stop();
    expect(errors).toEqual(['yap not found']);
  });
});

/** A fake yap for live dictation: `say` hands over a phrase that began at `at`, and stop hands over `last`. */
function liveSetup({ last = '', available = true, gate = Promise.resolve() } = {}) {
  const base = setup();
  let records = 0;
  const media = (base.voice as any).media as VoiceMedia;
  const record = media.record.bind(media);
  media.record = (stream) => {
    records++;
    return record(stream);
  };
  let phrase: ((text: string, at: number) => void) | undefined;
  let end: ((error?: string) => void) | undefined;
  let stops = 0;
  const dictate: LiveDictation = {
    async start(onPhrase, onEnd) {
      await gate;
      if (!available) return undefined;
      phrase = onPhrase;
      end = onEnd;
      return {
        stop: async () => {
          stops++;
          await settle();
          if (last) onPhrase(last, Number.MAX_SAFE_INTEGER);
          onEnd();
        },
      };
    },
  };
  (base.voice as any).opts.dictate = dictate;
  return { ...base, say: (text: string, at: number) => phrase!(text, at), fail: (error: string) => end!(error), records: () => records, stops: () => stops };
}

describe('ReviewVoice with live dictation', () => {
  it('sends each phrase to the target it began on, even when it lands after the voice moved', async () => {
    const { voice, heard, tick, say, records, isOpen } = liveSetup({ last: 'And the footer.' });
    await voice.start(OVERALL);
    expect(isOpen()).toBe(true);
    expect(records()).toBe(0);
    say('Make the header bigger.', 200);
    expect(heard).toEqual([[OVERALL, 'Make the header bigger.']]);

    tick(4000);
    voice.aim('c1');
    say('Started before the click.', 3500);
    tick(3000);
    say('Said after it.', 5000);
    expect(heard.slice(1)).toEqual([
      [OVERALL, 'Started before the click.'],
      ['c1', 'Said after it.'],
    ]);

    const stopped = voice.stop();
    expect(voice.recording).toBe(false);
    expect(voice.pending.has('c1')).toBe(true);
    await stopped;
    expect(heard.at(-1)).toEqual(['c1', 'And the footer.']);
    expect(voice.pending.size).toBe(0);
    expect(isOpen()).toBe(false);
  });

  it('records clips when live dictation is unavailable', async () => {
    const { voice, heard, tick, records } = liveSetup({ available: false });
    await voice.start('c1');
    tick(1000);
    await voice.stop();
    expect(records()).toBe(1);
    expect(heard).toEqual([['c1', 'clip@0']]);
  });

  it('stops listening and says why when yap fails', async () => {
    const { voice, errors, fail, isOpen, stops } = liveSetup();
    await voice.start('c1');
    fail('Dictation failed: Microphone permission is required.');
    await settle();
    expect(errors).toEqual(['Dictation failed: Microphone permission is required.']);
    expect(voice.recording).toBe(false);
    expect(isOpen()).toBe(false);
    expect(stops()).toBe(1);
  });

  it('a stop while dictation starts leaves nothing listening', async () => {
    let open = () => {};
    const { voice, isOpen, stops } = liveSetup({ gate: new Promise<void>((r) => (open = r)) });
    const starting = voice.start('c1');
    await settle();
    await voice.stop();
    open();
    await starting;
    await settle();
    expect(voice.recording).toBe(false);
    expect(isOpen()).toBe(false);
    expect(stops()).toBe(1);
  });
});
