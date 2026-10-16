/** The panel's microphone: voice for the next sketch Send, or spoken comments in a review. */

import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react';
import type { CompanionApi, Mode } from '../shared/ipc';
import type { BoardController } from './controller';
import type { DraftBook } from './drafts';
import { OVERALL, ReviewVoice } from './review-voice';
import type { ToastKind } from './Toast';

const MIC_DENIED =
  'Microphone access is off. Turn it on in System Settings > Privacy & Security > Microphone, then try again.';

export interface VoiceDeps {
  host: CompanionApi;
  book: DraftBook;
  controller: BoardController;
  mode: Mode;
  modeRef: RefObject<Mode>;
  notify: (text: string, kind?: ToastKind) => void;
}

export interface PanelVoice {
  reviewVoice: ReviewVoice;
  /** A review is open in Review mode, so the mic talks to its pins. */
  reviewing: boolean;
  recording: boolean;
  /** Sketch voice is waiting for the next Send. */
  hasVoice: boolean;
  /** The clock while recording. In Sketch it counts every take since the last Send. */
  elapsedMs: number;
  /** Sketch voice waiting for the next Send, in ms. */
  voiceMs: number;
  /** The open microphone, while recording. */
  input: MediaStream | undefined;
  toggleReviewVoice: () => Promise<void>;
  toggleRecording: () => Promise<void>;
  /** Drops the sketch voice, recording or not. */
  discardVoice: () => Promise<void>;
}

export function useVoice({ host, book, controller, mode, modeRef, notify }: VoiceDeps): PanelVoice {
  /** The review a recording started in, for words meant for its overall note. */
  const voiceDraft = useRef<string>(undefined);
  const [reviewVoice] = useState(
    () =>
      new ReviewVoice({
        transcribe: (clip) => host.transcribeClip(clip),
        onText: (target, text) => {
          const id = target === OVERALL ? voiceDraft.current : book.drafts.find((d) => d.review?.comments.some((c) => c.id === target))?.id;
          if (id) book.appendTo(id, target === OVERALL ? undefined : target, text);
        },
        onError: (message) => notify(message, 'error'),
      }),
  );

  const reviewing = useSyncExternalStore(
    (fn) => book.subscribe(fn),
    () => !!book.selected?.review,
  ) && mode === 'review';
  const reviewRecording = useSyncExternalStore(
    (fn) => reviewVoice.subscribe(fn),
    () => reviewVoice.recording,
  );
  const sketchRecording = useSyncExternalStore(
    (fn) => controller.recorder.subscribe(fn),
    () => controller.recorder.recording,
  );
  const recording = reviewing ? reviewRecording : sketchRecording;
  const hasVoice = useSyncExternalStore(
    (fn) => controller.recorder.subscribe(fn),
    () => controller.recorder.segments.length > 0,
  );
  const voiceMs = useSyncExternalStore(
    (fn) => controller.recorder.subscribe(fn),
    () => controller.recorder.recordedMs,
  );
  const input = reviewing ? reviewVoice.input : controller.recorder.input;
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [recording]);
  const since = reviewing ? reviewVoice.since : controller.recorder.since;
  const earlier = reviewing ? 0 : voiceMs;
  const elapsedMs = recording && since !== undefined ? earlier + Math.max(0, now - since) : 0;

  // In a review the mic talks to the pins: what you say goes to the selected comment.
  const toggleReviewVoice = async () => {
    if (reviewVoice.recording) {
      await reviewVoice.stop();
      return;
    }
    const access = await host.requestMicrophone();
    if (!access.granted) {
      notify(MIC_DENIED, 'error');
      return;
    }
    const draft = book.selected;
    if (!draft?.review || modeRef.current !== 'review') return;
    voiceDraft.current = draft.id;
    try {
      await reviewVoice.start(reviewVoice.target);
    } catch (err) {
      notify(`Could not start the microphone: ${(err as Error).message}`, 'error');
    }
  };

  // The mic button records voice for the next Send. It asks macOS first and says why when refused.
  const toggleRecording = async () => {
    if (controller.recorder.recording) {
      await controller.recorder.stop();
      return;
    }
    const access = await host.requestMicrophone();
    if (!access.granted) {
      notify(MIC_DENIED, 'error');
      return;
    }
    // Leaving Sketch while macOS asked about the mic cancels the start.
    if (modeRef.current !== 'sketch') return;
    try {
      await controller.recorder.start();
      if (modeRef.current !== 'sketch') await controller.recorder.stop();
    } catch (err) {
      notify(`Could not start the microphone: ${(err as Error).message}`, 'error');
    }
  };

  const discardVoice = () => controller.recorder.discard();

  return { reviewVoice, reviewing, recording, hasVoice, elapsedMs, voiceMs, input, toggleReviewVoice, toggleRecording, discardVoice };
}
