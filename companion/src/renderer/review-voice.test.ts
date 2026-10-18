import { describe, expect, it } from 'vitest';
import { OVERALL, ReviewVoice, type VoiceMedia } from './review-voice';

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
