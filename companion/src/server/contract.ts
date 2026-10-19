import type { AnnotationsPayload } from '../shared/annotations';
import type { BehaviorStore } from '../main/behavior';
import type { FeedbackStore } from '../main/feedback';
import type { FeedbackWorkspaces } from '../main/feedback-workspace';
import type { FeedbackSnaps } from '../main/feedback-snap';
/**
 * Seams between the socket server (src/server) and the Electron app (src/main).
 * The server owns sessions, deliveries and routing. The app owns the board.
 */

import type {
  DeleteRequest,
  Delivery,
  DrawRequest,
  DrawResponse,
  BoardsResponse,
  Initiative,
  InitiativeCreateRequest,
  InitiativeRevision,
  InitiativeSnapshot,
  InitiativeSummary,
  InitiativeUpdateRequest,
  ModePatch,
  MutateResponse,
  NoteRequest,
  NoteResponse,
  OpenRequest,
  OpenResponse,
  ReadResponse,
  SessionsResponse,
  UpdateRequest,
} from '../protocol';
import type { BoardComments, BoardPin } from '../shared/board-comments';
import type { ReviewPayload } from '../shared/review';

export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Implemented by the app. Every board route calls into it. */
export interface BoardBackend {
  health(): { panelVisible: boolean; currentBoard: string };
  /**
   * Shows the panel. With `output`, `sessionId` is live and the path is a Markdown or HTML file;
   * the backend opens it and throws BadRequest when the file is not inside the session's folder.
   */
  open(req: OpenRequest): Promise<OpenResponse>;
  listBoards(): Promise<BoardsResponse>;
  read(board: string, region?: Region): Promise<ReadResponse>;
  png(board: string, opts: { region?: Region; maxEdge?: number; pins?: BoardPin[] }): Promise<Buffer>;
  draw(board: string, req: DrawRequest): Promise<DrawResponse>;
  update(board: string, req: UpdateRequest): Promise<MutateResponse>;
  remove(board: string, req: DeleteRequest): Promise<MutateResponse>;
  /** Saves a note for POST /notes without showing the panel. A `sessionId` here is live. */
  addNote?(req: NoteRequest): NoteResponse | Promise<NoteResponse>;
  /** A session's item tracking. Undefined when the app keeps nothing for it. */
  tracking?(sessionId: string): { trackItems: boolean } | undefined;
  /** Turns item tracking on or off for a session. */
  setTracking?(sessionId: string, on: boolean): void | Promise<void>;
  /** A session's mode, mirrored from the mod. Undefined in default mode. */
  mode?(sessionId: string): ModePatch | undefined;
  /** Stores the mode the mod reports. `default` clears it, and a mode other than prototype has no fidelity. */
  setMode?(sessionId: string, patch: ModePatch): void | Promise<void>;
  /** Runs before an open makes the session the Send target, so the panel has its brief first. */
  claim?(sessionId: string): void;
}

/** What the app hands over when you press Send. */
export interface DeliveryInput {
  /** Defaults to the target session. */
  sessionId?: string;
  /** Board image, long edge 1400 px or less. Absent for a written draft alone. */
  png?: Buffer;
  /** Full Excalidraw scene JSON, present with `png`. */
  scene?: unknown;
  /** Empty for a written draft alone. */
  boardName: string;
  /** A written draft that leads the prompt. It references pictures as `![alt](att:<id>)`. */
  text?: string;
  /** The pictures `text` references. `name` is `<id>.<ext>`. */
  images?: { name: string; data: Buffer; mime: string }[];
  notes?: string;
  /** Rendered stroke and speech timeline (Phase 3). */
  timelineMd?: string;
  /** Phase 9 transcript index: t, tEnd, text, audio, audioStart. */
  transcript?: unknown;
  audio?: { name: string; data: Buffer }[];
  /** Short plain-text transcript for the draft. */
  speech?: string;
  mode?: 'fill' | 'submit';
  /** The project-relative file `text` was opened from. The prompt asks Claude to apply the draft to it. */
  sourcePath?: string;
  /** Comments pinned to an HTML file, written as review.md. Their pictures are among `images`. */
  review?: ReviewPayload;
  /** Comments pinned to the board, written as comments.md. Present with `png`. */
  comments?: BoardComments;
  /** Comments on passages of the written draft, written as annotations.md beside draft.md. */
  annotations?: AnnotationsPayload;
}

/**
 * Implemented by the app's initiative store. Every `/initiatives` route and
 * `/sessions/:id/initiative` calls into it. Errors carry a protocol `code`.
 */
export interface InitiativeBackend {
  list(): InitiativeSummary[];
  recent(limit: number): InitiativeSummary[];
  find(q: string): InitiativeSummary[];
  get(id: string): Initiative;
  history(id: string): InitiativeRevision[];
  create(req: InitiativeCreateRequest): Initiative;
  /** Throws a `conflict` error when `req.revision` is not the current one. */
  update(id: string, req: InitiativeUpdateRequest): Initiative;
  attach(sessionId: string, initiativeId: string): InitiativeSnapshot;
  detach(sessionId: string): boolean;
  snapshot(sessionId: string): InitiativeSnapshot | undefined;
}

export interface CompanionServerOptions {
  socketPath: string;
  backend: BoardBackend;
  /** Absent, the initiative routes answer 503. */
  initiatives?: InitiativeBackend;
  behaviors?: Pick<BehaviorStore, 'read' | 'update'>;
  feedback?: Pick<FeedbackStore, 'read' | 'update' | 'project'>;
  workspaces?: Pick<FeedbackWorkspaces, 'open'>;
  /** Absent, POST /sessions/:id/feedback/snap answers 503. */
  feedbackSnaps?: Pick<FeedbackSnaps, 'snap'>;
  now?: () => number;
}

export interface CompanionServer {
  listen(): Promise<void>;
  close(): Promise<void>;
  sessions(): SessionsResponse;
  setTarget(sessionId: string | undefined): void;
  /** Writes the bundle into the target session's project and queues it. */
  deliver(input: DeliveryInput): Promise<Delivery>;
  /** Fires when the session list or target changes. Returns an unsubscribe. */
  onSessionsChange(fn: (s: SessionsResponse) => void): () => void;
  /** Re-sends the session list after the backend changed what it adds, such as tracking or mode. */
  refreshSessions(): void;
  /** Fires on POST /open, after backend.open resolves. */
  onOpen(fn: (req: OpenRequest) => void): () => void;
}
