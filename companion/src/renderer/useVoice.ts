/** The panel's microphone: voice for the next sketch Send, or spoken comments in a review. */

import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react';
import type { CompanionApi, Mode } from '../shared/ipc';
import type { BoardCommentsStore } from './board-comments';
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
  comments: BoardCommentsStore;
  /** The open board, whose comments the mic talks to while they show. */
  board: string;
  mode: Mode;
  modeRef: RefObject<Mode>;
  notify: (text: string, kind?: ToastKind) => void;
}

export interface PanelVoice {
  reviewVoice: ReviewVoice;
  /** A review is open in Review mode, or the board shows comments, so the mic talks to pins. */
  reviewing: boolean;
  /** The board shows comments, so the mic talks to the board's pins. */
  commenting: boolean;
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

/** Marks a recording that belongs to a board's comments, as `voiceDraft` holds it. */
const BOARD = 'board:';

export function useVoice({ host, book, controller, comments, board, mode, modeRef, notify }: VoiceDeps): PanelVoice {
  /** The review a recording started in, for words meant for its overall note, or `board:<name>` for a board's comments. */
  const voiceDraft = useRef<string>(undefined);
  const [reviewVoice] = useState(
    () =>
      new ReviewVoice({
        transcribe: (clip) => host.transcribeClip(clip),
        onText: (target, text) => {
          const owner = voiceDraft.current;
          if (owner?.startsWith(BOARD) && (target === OVERALL || comments.owns(target))) {
            comments.append(owner.slice(BOARD.length), target, text);
            return;
          }
          const id = target === OVERALL ? voiceDraft.current : book.drafts.find((d) => d.review?.comments.some((c) => c.id === target))?.id;
          if (id) book.appendTo(id, target === OVERALL ? undefined : target, text);
        },
        onError: (message) => notify(message, 'error'),
      }),
  );

  const reviewingPage = useSyncExternalStore(
    (fn) => book.subscribe(fn),
    () => !!book.selected?.review,
  ) && mode === 'review';
  const commenting = useSyncExternalStore(
    (fn) => comments.subscribe(fn),
    () => comments.showing(board),
  ) && mode === 'sketch';
  const reviewing = reviewingPage || commenting;
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

  // Words go to the selected board pin, so the mic follows the selection.
  const selectedPin = useSyncExternalStore(
    (fn) => comments.subscribe(fn),
    () => comments.selected,
  );
  useEffect(() => {
    if (commenting && voiceDraft.current?.startsWith(BOARD)) reviewVoice.aim(selectedPin ?? OVERALL);
  }, [commenting, selectedPin, reviewVoice]);

  // Opening the comments while sketch voice records hands the mic to the pins. Closing them ends it.
  const wasCommenting = useRef(commenting);
  useEffect(() => {
    const was = wasCommenting.current;
    wasCommenting.current = commenting;
    if (commenting && !was && controller.recorder.recording) {
      void (async () => {
        await controller.recorder.stop();
        voiceDraft.current = `${BOARD}${board}`;
        await reviewVoice.start(comments.selected ?? OVERALL).catch((err: Error) => notify(`Could not start the microphone: ${err.message}`, 'error'));
      })();
    }
    if (!commenting && was && reviewVoice.recording && voiceDraft.current?.startsWith(BOARD)) void reviewVoice.stop();
  }, [commenting, controller, reviewVoice, comments, board, notify]);

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
    if (commenting) {
      if (modeRef.current !== 'sketch') return;
      voiceDraft.current = `${BOARD}${board}`;
      try {
        await reviewVoice.start(comments.selected ?? OVERALL);
      } catch (err) {
        notify(`Could not start the microphone: ${(err as Error).message}`, 'error');
      }
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

  return { reviewVoice, reviewing, commenting, recording, hasVoice, elapsedMs, voiceMs, input, toggleReviewVoice, toggleRecording, discardVoice };
}
