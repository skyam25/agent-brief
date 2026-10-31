import { describe, expect, it } from 'vitest';
import { OVERALL, ReviewVoice, type HeardWord, type LiveDictation, type VoiceMedia } from './review-voice';

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

  it('opens one microphone when a second start comes while the first is opening', async () => {
    const { voice, isOpen } = setup();
    await Promise.all([voice.start(OVERALL), voice.start(OVERALL)]);
    await voice.stop();
    expect(isOpen()).toBe(false);
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

/** A fake helper for live dictation: `say` hands over a phrase that began at `at`, `settle` words still settling, and stop hands over `last`. */
function liveSetup({ last = '', available = true, gate = Promise.resolve() } = {}) {
  const base = setup();
  let records = 0;
  const media = (base.voice as any).media as VoiceMedia;
  const record = media.record.bind(media);
  media.record = (stream) => {
    records++;
    return record(stream);
  };
  let phrase: ((text: string, at: number, words?: HeardWord[]) => void) | undefined;
  let end: ((error?: string) => void) | undefined;
  let ready: (() => void) | undefined;
  let live: ((text: string, at: number, words?: HeardWord[]) => void) | undefined;
  let stops = 0;
  const dictate: LiveDictation = {
    async start(onPhrase, onEnd, onReady, onLive) {
      await gate;
      if (!available) return undefined;
      phrase = onPhrase;
      end = onEnd;
      ready = onReady;
      live = onLive;
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
  return {
    ...base,
    say: (text: string, at: number, words?: HeardWord[]) => phrase!(text, at, words),
    settling: (text: string, at: number, words?: HeardWord[]) => live!(text, at, words),
    fail: (error: string) => end!(error),
    hears: () => ready!(),
    records: () => records,
    stops: () => stops,
  };
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

  it('splits speech that runs on across a click at the word where the voice moved', async () => {
    const { voice, heard, tick, say } = liveSetup();
    await voice.start('c1');
    tick(3000);
    voice.aim('c2');
    tick(3000);
    voice.aim('c3');
    tick(3000);
    const words = (pairs: [number, string][]) => pairs.map(([atMs, text]) => ({ text, atMs }));
    say('The header is too small, and this button is low contrast, and the footer is cramped.', 500, words([
      [500, 'The'], [900, 'header'], [1300, 'is'], [1500, 'too'], [1700, 'small,'],
      [2900, 'and'], [3100, 'this'], [3400, 'button'], [3800, 'is'], [4000, 'low'], [4300, 'contrast,'],
      [6000, 'and'], [6300, 'the'], [6600, 'footer'], [7000, 'is'], [7300, 'cramped.'],
    ]));
    expect(heard).toEqual([
      ['c1', 'The header is too small, and'],
      ['c2', 'this button is low contrast,'],
      ['c3', 'and the footer is cramped.'],
    ]);
    await voice.stop();
  });

  it('keeps the phrase text as printed when every word lands on one target', async () => {
    const { voice, heard, tick, say } = liveSetup();
    await voice.start('c1');
    tick(5000);
    voice.aim('c2');
    say('Make it  bigger.', 1000, [{ text: 'Make', atMs: 1000 }, { text: 'it', atMs: 1200 }, { text: 'bigger.', atMs: 1400 }]);
    expect(heard).toEqual([['c1', 'Make it  bigger.']]);
    await voice.stop();
  });

  it('records clips when live dictation is unavailable', async () => {
    const { voice, heard, tick, records } = liveSetup({ available: false });
    await voice.start('c1');
    tick(1000);
    await voice.stop();
    expect(records()).toBe(1);
    expect(heard).toEqual([['c1', 'clip@0']]);
  });

  it('stops listening and says why when dictation fails', async () => {
    const { voice, errors, fail, isOpen, stops } = liveSetup();
    await voice.start('c1');
    fail('Dictation failed: Microphone permission is required.');
    await settle();
    expect(errors).toEqual(['Dictation failed: Microphone permission is required.']);
    expect(voice.recording).toBe(false);
    expect(isOpen()).toBe(false);
    expect(stops()).toBe(1);
  });

  it('counts a click made while dictation starts, from when it happened', async () => {
    let open = () => {};
    const { voice, heard, tick, say, records } = liveSetup({ gate: new Promise<void>((r) => (open = r)) });
    const starting = voice.start('c1');
    await settle();
    tick(1000);
    voice.aim('c2');
    open();
    await starting;
    say('Bigger header. Shorter footer.', 500, [
      { text: 'Bigger', atMs: 500 },
      { text: 'header.', atMs: 800 },
      { text: 'Shorter', atMs: 1200 },
      { text: 'footer.', atMs: 1500 },
    ]);
    expect(heard).toEqual([
      ['c1', 'Bigger header.'],
      ['c2', 'Shorter footer.'],
    ]);
    expect(records()).toBe(0);
    await voice.stop();
  });

  it('says it is starting until dictation hears the microphone', async () => {
    const { voice, hears } = liveSetup();
    await voice.start('c1');
    expect(voice.starting).toBe(true);
    hears();
    expect(voice.starting).toBe(false);
    await voice.stop();
  });

  it('shows words still settling on the target each began on, until the phrase lands', async () => {
    const { voice, heard, tick, say, settling } = liveSetup();
    await voice.start('c1');
    tick(3000);
    voice.aim('c2');
    const words = [
      { text: 'Bigger', atMs: 2000 },
      { text: 'header,', atMs: 2600 },
      { text: 'darker', atMs: 3200 },
    ];
    settling('Bigger header, darker', 2000, words);
    expect([...voice.settling]).toEqual([
      ['c1', 'Bigger header,'],
      ['c2', 'darker'],
    ]);
    expect(heard).toEqual([]);
    say('Bigger header, darker button.', 2000, [...words, { text: 'button.', atMs: 3500 }]);
    expect(voice.settling.size).toBe(0);
    expect(heard).toEqual([
      ['c1', 'Bigger header,'],
      ['c2', 'darker button.'],
    ]);
    settling('And', 4000);
    await voice.stop();
    expect(voice.settling.size).toBe(0);
  });

  it('opens the microphone and dictation together, so a helper that hears first is not starting', async () => {
    let opened = (_: MediaStream) => {};
    const { voice, hears } = liveSetup();
    const media = (voice as any).media as VoiceMedia;
    media.open = () => new Promise((r) => (opened = r));
    const starting = voice.start('c1');
    await settle();
    hears();
    opened({} as MediaStream);
    await starting;
    expect(voice.recording).toBe(true);
    expect(voice.starting).toBe(false);
    await voice.stop();
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
