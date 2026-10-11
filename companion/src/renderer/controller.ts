/** Owns the visible board: loading, autosave, notes, and the board requests main sends in. */

import {
  CaptureUpdateAction,
  getSceneVersion,
  newElementWith,
  getVisibleSceneBounds,
  restore,
  serializeAsJSON,
} from '@excalidraw/excalidraw';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { BinaryFiles, ExcalidrawImperativeAPI, NormalizedZoomValue } from '@excalidraw/excalidraw/types';
import type { BoardHost, BoardReply, BoardRequest, SendPayload } from '../shared/ipc';
import { boxOf, union, type Shaped } from '../board/geometry';
import { buildTimeline } from '../voice/timeline';
import { drawElements, readElements, removeElements, renderPng, updateElements } from './ops';
import { Recorder } from './recorder';
import { StrokeLog, rebase } from './strokes';

type El = ExcalidrawElement;

export const SAVE_DELAY_MS = 500;
export const SEND_MAX_EDGE = 1400;
/** How long a paste may take to land, such as an image still decoding. */
const PASTE_WAIT_MS = 3000;

export interface LoadedScene {
  elements: El[];
  appState: { viewBackgroundColor: string };
  files: BinaryFiles;
}

export function parseScene(json: string | null): LoadedScene {
  const data = json ? JSON.parse(json) : null;
  const restored = restore(data, null, null, { repairBindings: true });
  return {
    elements: restored.elements as El[],
    appState: { viewBackgroundColor: restored.appState.viewBackgroundColor || '#ffffff' },
    files: restored.files,
  };
}

/**
 * Loads the font faces that `text` needs. Excalidraw measures labels when they
 * are created, so measuring before the font arrives gives wrong sizes.
 */
async function loadFonts(text: string): Promise<void> {
  await Promise.all(['Excalifont', 'Xiaolai'].map((f) => document.fonts.load(`20px ${f}`, text).catch(() => [])));
}

/** A board to work on: the visible one, or one loaded from disk. */
interface SceneHandle {
  elements: readonly El[];
  files: BinaryFiles;
  commit(next: El[]): Promise<void>;
}

export class BoardController {
  api?: ExcalidrawImperativeAPI;
  board: string;
  notes: string;
  private sceneVersion = -1;
  private sceneTimer?: ReturnType<typeof setTimeout>;
  private notesTimer?: ReturnType<typeof setTimeout>;
  /** When each element first appeared this session. Elements loaded from disk are known but undated. */
  private firstSeen = new Map<string, number | undefined>();
  /** Board changes since the last Send, for the timeline. */
  readonly strokes: StrokeLog;
  readonly recorder: Recorder;
  /** Whether the panel is on screen. Hosts without a hideable window leave it true. */
  panelVisible = true;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly bridge: BoardHost,
    initial: { board: string; notes: string; scene: LoadedScene },
  ) {
    this.board = initial.board;
    this.notes = initial.notes;
    this.strokes = new StrokeLog(initial.scene.elements);
    this.recorder = new Recorder();
    this.markLoaded(initial.scene.elements);
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  attach(api: ExcalidrawImperativeAPI): void {
    this.api = api;
  }

  private markLoaded(elements: readonly El[]): void {
    this.firstSeen = new Map(elements.map((e) => [e.id, undefined]));
    this.sceneVersion = getSceneVersion(elements);
  }

  /** Excalidraw's onChange. Saves when the elements changed, not on scroll or selection. */
  handleChange(elements: readonly El[]): void {
    const now = Date.now();
    // While the panel is hidden only Claude's drawing reaches the timeline.
    this.strokes.observe(elements, now, this.panelVisible ? undefined : (e) => e.by === 'claude');
    for (const e of elements) if (!this.firstSeen.has(e.id)) this.firstSeen.set(e.id, now);
    const version = getSceneVersion(elements);
    if (version === this.sceneVersion) return;
    this.sceneVersion = version;
    this.scheduleSceneSave();
  }

  setNotes(text: string): void {
    this.notes = text;
    clearTimeout(this.notesTimer);
    this.notesTimer = setTimeout(() => void this.saveNotes(), SAVE_DELAY_MS);
    this.emit();
  }

  private scheduleSceneSave(): void {
    clearTimeout(this.sceneTimer);
    this.sceneTimer = setTimeout(() => void this.saveScene(), SAVE_DELAY_MS);
  }

  private serializeVisible(): string {
    const api = this.api!;
    const scene = JSON.parse(
      serializeAsJSON(api.getSceneElementsIncludingDeleted(), api.getAppState(), api.getFiles(), 'local'),
    ) as { elements: { id: string; customData?: Record<string, unknown> }[] };
    for (const e of scene.elements) {
      const seen = this.firstSeen.get(e.id);
      if (seen !== undefined && e.customData?.createdAt === undefined) {
        e.customData = { ...e.customData, createdAt: seen };
      }
    }
    return JSON.stringify(scene, null, 2);
  }

  private async saveScene(): Promise<void> {
    clearTimeout(this.sceneTimer);
    this.sceneTimer = undefined;
    if (!this.api) return;
    await this.bridge.saveBoard(this.board, this.serializeVisible());
  }

  private async saveNotes(): Promise<void> {
    clearTimeout(this.notesTimer);
    this.notesTimer = undefined;
    await this.bridge.saveNotes(this.board, this.notes);
  }

  /** Writes pending saves now. */
  async flush(): Promise<void> {
    const work: Promise<void>[] = [];
    if (this.sceneTimer !== undefined) work.push(this.saveScene());
    if (this.notesTimer !== undefined) work.push(this.saveNotes());
    await Promise.all(work);
  }

  /** Runs board work one at a time, so requests and board switches never interleave. */
  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  switchTo(board: string): Promise<void> {
    return this.enqueue(() => this.show(board));
  }

  async createBoard(name: string): Promise<void> {
    const clean = await this.bridge.createBoard(name);
    await this.switchTo(clean);
  }

  renameBoard(to: string): Promise<void> {
    return this.enqueue(async () => {
      await this.flush();
      this.board = await this.bridge.renameBoard(this.board, to);
      this.emit();
    });
  }

  private async show(board: string): Promise<void> {
    const api = this.api!;
    if (board === this.board) return;
    await this.flush();
    const { scene, notes } = await this.bridge.loadBoard(board);
    const loaded = parseScene(scene);
    this.board = board;
    this.notes = notes;
    this.markLoaded(loaded.elements);
    this.strokes.reset(loaded.elements);
    api.updateScene({ elements: loaded.elements, appState: loaded.appState, captureUpdate: CaptureUpdateAction.NEVER });
    const files = Object.values(loaded.files);
    if (files.length) api.addFiles(files);
    api.history.clear();
    // Fits what the board holds without zooming past 100%. An empty board starts at the origin, unzoomed.
    const live = loaded.elements.filter((e) => !e.isDeleted);
    if (live.length) api.scrollToContent(live, { fitToViewport: true, viewportZoomFactor: 0.8, maxZoom: 1, animate: false });
    else api.updateScene({ appState: { scrollX: 0, scrollY: 0, zoom: { value: 1 as NormalizedZoomValue } }, captureUpdate: CaptureUpdateAction.NEVER });
    await this.bridge.setCurrent(board);
    this.emit();
  }

  private async sceneFor(board: string): Promise<SceneHandle> {
    const api = this.api!;
    if (board === this.board) {
      return {
        elements: api.getSceneElementsIncludingDeleted(),
        files: api.getFiles(),
        commit: async (next) => {
          api.updateScene({ elements: next, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
          this.scheduleSceneSave();
        },
      };
    }
    const { scene } = await this.bridge.loadBoard(board);
    const loaded = parseScene(scene);
    return {
      elements: loaded.elements,
      files: loaded.files,
      commit: async (next) => {
        await this.bridge.saveBoard(board, serializeAsJSON(next, loaded.appState, loaded.files, 'local'));
      },
    };
  }

  /** Scrolls to new elements unless all of them show, so the user sees what Claude drew. */
  private revealIfHidden(ids: string[]): void {
    const api = this.api!;
    const wanted = new Set(ids);
    const drawn = api.getSceneElements().filter((e) => wanted.has(e.id));
    if (drawn.length === 0) return;
    const [minX, minY, maxX, maxY] = getVisibleSceneBounds(api.getAppState());
    const inView = drawn.every((e) => e.x >= minX && e.x + e.width <= maxX && e.y >= minY && e.y + e.height <= maxY);
    if (!inView) api.scrollToContent(drawn, { animate: true });
  }

  /** Builds the hand-off. Stops recording first so the last clip is complete. */
  async payload(): Promise<SendPayload> {
    await this.flush();
    if (this.recorder.recording) await this.recorder.stop();
    const api = this.api!;
    const elements = api.getSceneElementsIncludingDeleted();
    const { strokes, segments } = rebase(this.strokes.events, this.recorder.segments);
    const liveBoxes = elements.filter((e) => !e.isDeleted).map((e) => boxOf(e as unknown as Shaped));
    const bounds = union(liveBoxes);
    const { strokeNumbers, imageLetters } = buildTimeline({ strokes, utterances: [], bounds });
    return {
      boardName: this.board,
      png: await renderPng(elements, api.getFiles(), {
        maxEdge: SEND_MAX_EDGE,
        numbers: { ...strokeNumbers, ...imageLetters },
      }),
      scene: JSON.parse(this.serializeVisible()),
      notes: this.notes,
      strokes,
      segments: segments.map((s) => ({ name: s.name, data: s.data, startMs: s.startMs, mimeType: s.mimeType })),
      bounds,
    };
  }

  /** Starts a new sketch session after a successful Send. */
  resetSession(): void {
    this.recorder.clear();
    if (this.api) this.strokes.reset(this.api.getSceneElementsIncludingDeleted());
  }

  /**
   * Runs on paste. Excalidraw selects what it pasted and switches to the
   * selection tool, so the pen would need a click away before the next stroke.
   * Once the paste lands, this deselects it and hands the pen back.
   */
  afterPaste(): void {
    const api = this.api;
    if (!api || api.getAppState().activeTool.type !== 'freedraw') return;
    const before = new Set(api.getSceneElementsIncludingDeleted().map((e) => e.id));
    const started = Date.now();
    const check = () => {
      if (api.getSceneElements().some((e) => !before.has(e.id))) {
        api.updateScene({ appState: { selectedElementIds: {} }, captureUpdate: CaptureUpdateAction.NEVER });
        api.setActiveTool({ type: 'freedraw' });
        return;
      }
      if (Date.now() - started < PASTE_WAIT_MS) setTimeout(check, 50);
    };
    setTimeout(check, 0);
  }

  /**
   * Empties the visible board and its notes after a Send, so the next sketch
   * starts blank. History keeps what went out.
   */
  clearBoard(): void {
    const api = this.api;
    if (!api) return;
    const elements = api.getSceneElementsIncludingDeleted().map((e) => (e.isDeleted ? e : newElementWith(e, { isDeleted: true })));
    api.updateScene({ elements, captureUpdate: CaptureUpdateAction.NEVER });
    // Records the deletions now, so the next session's stroke log starts after them.
    this.handleChange(api.getSceneElementsIncludingDeleted());
    api.history.clear();
    this.setNotes('');
    this.resetSession();
  }

  /** Answers a request from main with a reply that keeps the error code. */
  async reply(req: BoardRequest): Promise<BoardReply> {
    try {
      return { id: req.id, ok: true, result: await this.handle(req) };
    } catch (err) {
      const e = err as { message?: string; code?: string };
      return { id: req.id, ok: false, error: { message: e?.message ?? String(err), code: e?.code } };
    }
  }

  /** Answers a request from main. */
  handle(req: BoardRequest): Promise<unknown> {
    return this.enqueue(async () => {
      const a = req.args as Record<string, any>;
      switch (req.op) {
        case 'read': {
          const h = await this.sceneFor(a.board);
          const seen = a.board === this.board ? (id: string) => this.firstSeen.get(id) : undefined;
          return readElements(a.board, h.elements, a.region, seen);
        }
        case 'draw':
        case 'update':
        case 'remove': {
          await loadFonts(JSON.stringify(a.req));
          const h = await this.sceneFor(a.board);
          const fn = req.op === 'draw' ? drawElements : req.op === 'update' ? updateElements : removeElements;
          const { next, response } = fn(h.elements, a.req, a.batchId);
          await h.commit(next);
          if (req.op === 'draw' && a.board === this.board) this.revealIfHidden(response.ids);
          return response;
        }
        case 'png': {
          const h = await this.sceneFor(a.board);
          return renderPng(h.elements, h.files, { region: a.region, maxEdge: a.maxEdge });
        }
        case 'show':
          return this.show(a.board);
        case 'payload':
          return this.payload();
        case 'resetSession':
          return this.resetSession();
        case 'flush':
          return this.flush();
        default:
          throw Object.assign(new Error(`unknown op ${String(req.op)}`), { code: 'bad_request' });
      }
    });
  }
}
