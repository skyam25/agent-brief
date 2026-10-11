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
  MutateResponse,
  OpenRequest,
  OpenResponse,
  ReadResponse,
  SessionsResponse,
  UpdateRequest,
} from '../protocol';

export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Implemented by the app. Every board route calls into it. */
export interface BoardBackend {
  health(): { panelVisible: boolean; currentBoard: string };
  open(req: OpenRequest): Promise<OpenResponse>;
  listBoards(): Promise<BoardsResponse>;
  read(board: string, region?: Region): Promise<ReadResponse>;
  png(board: string, opts: { region?: Region; maxEdge?: number }): Promise<Buffer>;
  draw(board: string, req: DrawRequest): Promise<DrawResponse>;
  update(board: string, req: UpdateRequest): Promise<MutateResponse>;
  remove(board: string, req: DeleteRequest): Promise<MutateResponse>;
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
  /** A written draft that leads the prompt. */
  text?: string;
  notes?: string;
  /** Rendered stroke and speech timeline (Phase 3). */
  timelineMd?: string;
  /** Phase 9 transcript index: t, tEnd, text, audio, audioStart. */
  transcript?: unknown;
  audio?: { name: string; data: Buffer }[];
  /** Short plain-text transcript for the draft. */
  speech?: string;
  mode?: 'fill' | 'submit';
}

export interface CompanionServerOptions {
  socketPath: string;
  backend: BoardBackend;
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
  /** Fires on POST /open, after backend.open resolves. */
  onOpen(fn: (req: OpenRequest) => void): () => void;
}
