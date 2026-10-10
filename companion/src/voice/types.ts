/** Shapes shared by the app's renderer (recording, stroke capture) and the Node voice code. */

import type { ShapeType } from '../protocol';

/** One recorded audio clip. Times are ms since the sketch session started. */
export interface VoiceSegment {
  /** File name, such as `seg-0.webm`. Delivered as `audio/<name>`. */
  name: string;
  data: Buffer;
  /** ms since the sketch session started, where this clip's audio begins. */
  startMs: number;
  /** WebM/Opus in 30 s segments, so `audio/webm;codecs=opus`. */
  mimeType: string;
}

/** One change to the board, in ms since the sketch session started. */
export interface StrokeEvent {
  t: number;
  tEnd: number;
  elementId: string;
  type: ShapeType | 'image';
  bbox: { x: number; y: number; width: number; height: number };
  label?: string;
  by: 'user' | 'claude';
  kind: 'add' | 'erase' | 'move';
}

/** One sentence of speech. Same shape as the extension's transcript index. */
export interface Utterance {
  /** ms since the sketch session started. */
  t: number;
  tEnd: number;
  text: string;
  /** Path of the clip holding it, such as `audio/seg-0.webm`. */
  audio: string;
  /** Session ms where that clip starts. Offset into the clip = t - audioStart. */
  audioStart: number;
}
