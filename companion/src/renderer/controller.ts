/** Owns the visible board: loading, autosave, notes, and the board requests main sends in. */

import { CaptureUpdateAction, getSceneVersion, newElementWith, restore, serializeAsJSON } from '@excalidraw/excalidraw';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { AppState, BinaryFiles, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import type { BoardLayout } from '../protocol';
import type { BoardPin } from '../shared/board-comments';
import type { BoardHost, BoardReply, BoardRequest, SendPayload } from '../shared/ipc';
import { boxOf, union, type Shaped } from '../board/geometry';
import { pinSpot, type Pinnable } from '../board/pin';
import { TEXT_FONT_NAME } from '../board/palette';
import { isStackFrame, layoutOfScene, planIsEmpty, stackNames, withLayout, type StackElement } from '../board/stack';
import type { StrokeEvent } from '../voice/types';
import { buildTimeline } from '../voice/timeline';
import type { PlannedFile } from '../board/skeleton';
import { shrinkImages, textOf } from './images';
import { drawElements, readElements, removeElements, updateElements } from './ops';
import { renderPng } from './png';
import { Recorder } from './recorder';
import { applyPlan, imagesFor, isBusy, joinGroup, plan as planStack } from './stack';
import { StrokeLog, rebase } from './strokes';
import { fitBoard, revealIfHidden } from './viewport';

type El = ExcalidrawElement;

export const SAVE_DELAY_MS = 500;
export const SEND_MAX_EDGE = 1400;
/** How long a paste may take to land, such as an image still decoding. */
const PASTE_WAIT_MS = 3000;

export interface LoadedScene {
  elements: El[];
  appState: { viewBackgroundColor: string };
  files: BinaryFiles;
  layout: BoardLayout;
}

export function parseScene(json: string | null): LoadedScene {
  const data = json ? JSON.parse(json) : null;
  const restored = restore(data, null, null, { repairBindings: true });
  return {
    elements: restored.elements as El[],
    appState: { viewBackgroundColor: restored.appState.viewBackgroundColor || '#ffffff' },
    files: restored.files,
    layout: layoutOfScene(data),
  };
}

/**
 * Loads the font faces that `text` needs. Excalidraw measures labels when they
 * are created, so measuring before the font arrives gives wrong sizes.
 */
async function loadFonts(text: string): Promise<void> {
  await Promise.all([TEXT_FONT_NAME, 'Excalifont', 'Xiaolai'].map((f) => document.fonts.load(`20px ${f}`, text).catch(() => [])));
}

/** A board to work on: the visible one, or one loaded from disk. */
interface SceneHandle {
  elements: readonly El[];
  files: BinaryFiles;
  /** Saves the elements, plus any pictures new image elements show. */
  commit(next: El[], files?: PlannedFile[]): Promise<void>;
}

const asStack = (els: readonly El[]) => els as unknown as readonly StackElement[];

function binaryFiles(files: PlannedFile[] = [], now = Date.now()): BinaryFiles {
  return Object.fromEntries(files.map((f) => [f.id, { ...f, created: now }])) as unknown as BinaryFiles;
}

export class BoardController {
  api?: ExcalidrawImperativeAPI;
  board: string;
  notes: string;
  layout: BoardLayout;
  private sceneVersion = -1;
  /** Set while the Stack layout moves things, so the timeline does not log its moves as the user's. */
  private absorbing = false;
  private reflowTimer?: ReturnType<typeof setTimeout>;
  /** Set when a layout pass waited for a drag to end. */
  private reflowWaiting = false;
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
    this.layout = initial.scene.layout;
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
    if (this.absorbing) this.strokes.absorb(elements);
    else {
      // Stack group frames are layout, not marks. While the panel is hidden only Claude's drawing reaches the timeline.
      const frames = new Set(asStack(elements).filter(isStackFrame).map((e) => e.id));
      const keep = (e: StrokeEvent) => !frames.has(e.elementId) && (this.panelVisible || e.by === 'claude');
      this.strokes.observe(elements, now, keep);
    }
    for (const e of elements) if (!this.firstSeen.has(e.id)) this.firstSeen.set(e.id, now);
    const version = getSceneVersion(elements);
    if (version === this.sceneVersion) return;
    this.sceneVersion = version;
    this.scheduleSceneSave();
    if (this.layout === 'stack' && !this.absorbing) this.scheduleReflow();
  }

  // ── Stack layout ──────────────────────────────────────────────────────

  private scheduleReflow(): void {
    clearTimeout(this.reflowTimer);
    this.reflowTimer = setTimeout(() => this.reflow(), 0);
  }

  /** Lays the stack out again. Waits while the user drags or draws. */
  private reflow(): void {
    const api = this.api;
    if (!api || this.layout !== 'stack') return;
    if (isBusy(api.getAppState())) {
      this.reflowWaiting = true;
      return;
    }
    const elements = api.getSceneElementsIncludingDeleted();
    const p = planStack(elements);
    if (planIsEmpty(p)) return;
    this.absorbing = true;
    try {
      api.updateScene({ elements: applyPlan(elements, p), captureUpdate: CaptureUpdateAction.NEVER });
      this.strokes.absorb(api.getSceneElementsIncludingDeleted());
    } finally {
      this.absorbing = false;
    }
    this.scheduleSceneSave();
  }

  /** Excalidraw's onChange, for the app state. A drag that ends changes no elements, so this lays out what it moved. */
  handleAppState(state: AppState): void {
    if (!this.reflowWaiting || isBusy(state)) return;
    this.reflowWaiting = false;
    this.scheduleReflow();
  }

  /**
   * Files dropped or pasted on a Stack board. One drop or paste is one group:
   * the group under the drop point or the selected group, else a new one at the end.
   */
  addScreenshots(files: File[], at?: { x: number; y: number }): Promise<void> {
    return this.enqueue(async () => {
      const api = this.api;
      if (!api || files.length === 0) return;
      const join = joinGroup(api.getSceneElements(), api.getAppState().selectedElementIds, at);
      const made = await imagesFor(files);
      const all = [...api.getSceneElementsIncludingDeleted(), ...made.elements];
      const ids = made.elements.map((e) => e.id);
      const next = applyPlan(all, planStack(all, { ids, join }));
      api.updateScene({ elements: next, appState: { selectedElementIds: {} }, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
      // Excalidraw loads a file only for images already in the scene, so the files go in after them.
      api.addFiles(Object.values(binaryFiles(made.files)));
      // Shows the whole group, with its number, rather than just the new pictures.
      const group = next.find((e) => e.id === ids[0])?.frameId;
      revealIfHidden(api, group ? [group] : ids);
    });
  }

  /** Switches the visible board between freeform and Stack. Turning Stack on files the loose pictures. */
  setLayout(layout: BoardLayout): Promise<void> {
    return this.enqueue(() => this.layoutOf(this.board, layout));
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
    const raw = JSON.parse(
      serializeAsJSON(api.getSceneElementsIncludingDeleted(), api.getAppState(), api.getFiles(), 'local'),
    ) as { elements: { id: string; customData?: Record<string, unknown> }[] };
    const scene = withLayout(raw, this.layout);
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

  async createBoard(name: string, layout: BoardLayout = 'freeform'): Promise<void> {
    const clean = await this.bridge.createBoard(name);
    await this.switchTo(clean);
    if (layout !== 'freeform') await this.setLayout(layout);
  }

  renameBoard(to: string): Promise<void> {
    return this.enqueue(async () => {
      await this.flush();
      this.board = await this.bridge.renameBoard(this.board, to);
      this.emit();
    });
  }

  /**
   * Moves a board to the Trash. Deleting the open board first opens the most
   * recently changed other board, or a fresh one when none is left.
   */
  deleteBoard(name: string): Promise<void> {
    return this.enqueue(async () => {
      if (name === this.board) {
        const others = (await this.bridge.listBoards()).filter((b) => b.name !== name);
        others.sort((a, b) => b.updatedAt - a.updatedAt);
        const next = others[0]?.name ?? (await this.bridge.createBoard(name === 'scratch' ? 'board' : 'scratch'));
        await this.show(next);
      }
      await this.bridge.deleteBoard(name);
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
    this.layout = loaded.layout;
    this.markLoaded(loaded.elements);
    this.strokes.reset(loaded.elements);
    api.updateScene({ elements: loaded.elements, appState: loaded.appState, captureUpdate: CaptureUpdateAction.NEVER });
    const files = Object.values(loaded.files);
    if (files.length) api.addFiles(files);
    // Pictures Claude added while the board was hidden join the stack now.
    this.reflow();
    api.history.clear();
    fitBoard(api, loaded.elements.filter((e) => !e.isDeleted));
    await this.bridge.setCurrent(board);
    this.emit();
  }

  private async sceneFor(board: string): Promise<SceneHandle> {
    const api = this.api!;
    if (board === this.board) {
      return {
        elements: api.getSceneElementsIncludingDeleted(),
        files: api.getFiles(),
        commit: async (next, files) => {
          if (files?.length) api.addFiles(Object.values(binaryFiles(files)));
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
      commit: async (next, files) => {
        const all = { ...loaded.files, ...binaryFiles(files) };
        const json = JSON.parse(serializeAsJSON(next, loaded.appState, all, 'local'));
        await this.bridge.saveBoard(board, JSON.stringify(withLayout(json, loaded.layout), null, 2));
      },
    };
  }

  /** Builds the hand-off. Stops recording first so the last clip is complete. Comment `pins` show on the PNG as numbered badges. */
  async payload(pins?: readonly BoardPin[]): Promise<SendPayload> {
    await this.flush();
    if (this.recorder.recording) await this.recorder.stop();
    const api = this.api!;
    const elements = api.getSceneElementsIncludingDeleted();
    const { strokes, segments } = rebase(this.strokes.events, this.recorder.segments);
    const liveBoxes = elements.filter((e) => !e.isDeleted).map((e) => boxOf(e as unknown as Shaped));
    const bounds = union(liveBoxes);
    const imageNames = stackNames(asStack(elements));
    const { strokeNumbers, imageLetters } = buildTimeline({ strokes, utterances: [], bounds, imageNames });
    const byId = new Map((elements as unknown as Pinnable[]).map((e) => [e.id, e]));
    const pinSpots = pins?.map((p) => pinSpot(p, byId).at);
    return {
      boardName: this.board,
      png: await renderPng(elements, api.getFiles(), {
        maxEdge: SEND_MAX_EDGE,
        numbers: { ...strokeNumbers, ...imageLetters },
        ...(pinSpots?.length ? { pins: pinSpots } : {}),
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

  /** Sets a board's layout. Runs inside the request queue. */
  private async layoutOf(board: string, layout: BoardLayout): Promise<void> {
    if (board === this.board) {
      if (layout === this.layout) return;
      this.layout = layout;
      this.reflow();
      await this.saveScene();
      this.emit();
      return;
    }
    const { scene } = await this.bridge.loadBoard(board);
    const data = JSON.parse(scene ?? '{}');
    await this.bridge.saveBoard(board, JSON.stringify(withLayout(data, layout), null, 2));
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
        case 'draw': {
          const drawReq = await shrinkImages(a.req);
          await loadFonts(textOf(drawReq));
          const h = await this.sceneFor(a.board);
          const { next, response, files } = drawElements(h.elements, drawReq, a.batchId);
          await h.commit(next, files);
          if (a.board === this.board) revealIfHidden(this.api!, response.ids);
          return response;
        }
        case 'update':
        case 'remove': {
          await loadFonts(JSON.stringify(a.req));
          const h = await this.sceneFor(a.board);
          const fn = req.op === 'update' ? updateElements : removeElements;
          const { next, response } = fn(h.elements, a.req, a.batchId);
          await h.commit(next);
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
        case 'layout':
          return this.layoutOf(a.board, a.layout);
        default:
          throw Object.assign(new Error(`unknown op ${String(req.op)}`), { code: 'bad_request' });
      }
    });
  }
}
