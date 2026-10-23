import { afterEach, expect, it, vi } from 'vitest';
import { Recorder } from './recorder';

afterEach(() => vi.unstubAllGlobals());

it('closes a microphone granted after the board was left', async () => {
  let grant!: (stream: MediaStream) => void;
  const track = { stop: vi.fn() };
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: () => new Promise<MediaStream>((resolve) => { grant = resolve; }) } });
  const recorder = new Recorder();
  const opening = recorder.start();
  await recorder.stop();
  grant({ getTracks: () => [track] } as unknown as MediaStream);
  await opening;
  expect(track.stop).toHaveBeenCalledOnce();
  expect(recorder.recording).toBe(false);
});
