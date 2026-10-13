/**
 * Agent Brief socket protocol, shared by the app, the `agent-brief` CLI and the
 * agent-brief mod. HTTP/1.1 with JSON bodies over a Unix socket.
 *
 * Add fields and routes only. Never rename or remove.
 */

export const PROTOCOL_VERSION = 1;

/** Overrides the socket path. Tests set it to a temp file. */
export const SOCKET_ENV = 'COMPANION_SOCKET';

/** `~/Library/Application Support/AgentBrief/agent-brief.sock`, file mode 0600. */
export function defaultSocketPath(home: string): string {
  return `${home}/Library/Application Support/AgentBrief/agent-brief.sock`;
}

/** Board name that resolves to the board the panel shows now. */
export const CURRENT_BOARD = 'current';

// ── Errors ────────────────────────────────────────────────────────────────
// Every non-2xx response has this body. A body over 20 MB gets 413.
// Requests with a body, DELETE included, must send Content-Length.

export interface ErrorBody {
  error: string;
  code: 'not_found' | 'bad_request' | 'conflict' | 'unavailable' | 'internal';
}

// ── GET /health ───────────────────────────────────────────────────────────

export interface Health {
  ok: true;
  version: number;
  pid: number;
  panelVisible: boolean;
  currentBoard: string;
}

// ── Sessions ──────────────────────────────────────────────────────────────
// POST /sessions registers or refreshes a Claude Code session.
// DELETE /sessions/:id removes one. GET /sessions lists them.
// A session that neither re-registers nor polls for 90 s drops out.

export interface SessionInfo {
  sessionId: string;
  /** The session's working folder. Deliveries are written under it. */
  cwd: string;
  title?: string;
  pid?: number;
  /** The user's latest typed prompt, trimmed, so two sessions in one folder look different. */
  summary?: string;
  /** Where the session runs, for its label and for jumping back to it. */
  host?: SessionHost;
  /** Set by the app. Epoch ms of the last register or poll. */
  lastSeen?: number;
  /** Set by the app. True when the user asked Claude to keep an items file for this session. */
  trackItems?: boolean;
  /** Set by the app when tracking is on: `<cwd>/.feedback/items/<sessionId>.md`. */
  itemsPath?: string;
  /** Set by the app for a live session: `<cwd>/.feedback/outputs/<sessionId>.json`, where the mod records outputs. */
  outputsPath?: string;
  /** The session's mode, mirrored from the mod. Absent means default. */
  mode?: SessionMode;
  /** The prototype fidelity, mirrored from the mod. Only set with `mode: 'prototype'`. */
  fidelity?: PrototypeFidelity;
}

// GET   /sessions/:id              → SessionInfo, with its tracking state and mode
// PATCH /sessions/:id              TrackingPatch | ModePatch → SessionInfo
// Tracking is the user's choice, from the panel or `/track` in the session.
// The app only reads the items file; Claude writes it, and the panel appends the user's decisions.
// Mode is the mod's. The app stores and shows it; it never sets it.

export interface TrackingPatch {
  trackItems: boolean;
}

export type SessionMode = 'default' | 'product' | 'prototype' | 'orchestrate';

export type PrototypeFidelity = 'wireframe' | 'styled' | 'live-patch' | 'freeze-patch' | 'interactive' | 'existing';

export interface ModePatch {
  mode: SessionMode;
  fidelity?: PrototypeFidelity;
}

export interface SessionHost {
  /** `TERM_PROGRAM`, such as `ghostty`, `iTerm.app`, `Apple_Terminal` or `vscode`. */
  terminal?: string;
  /** Bundle id of the app the terminal runs in, from `__CFBundleIdentifier`. */
  bundleId?: string;
  /** herdr pane id, from `HERDR_PANE_ID`, when the session runs inside herdr. */
  herdrPane?: string;
}

/** POST /sessions answers with the full list. DELETE /sessions/:id answers with this. */
export interface RemoveSessionResponse {
  removed: boolean;
}

export interface SessionsResponse {
  sessions: SessionInfo[];
  /**
   * The session Send delivers to. Only `/open` with a session id or an explicit
   * pick sets it, and it clears when that session leaves.
   */
  targetSessionId?: string;
}

// ── POST /open ────────────────────────────────────────────────────────────
// Shows the panel. Picks the target session when one is given.

export interface OpenRequest {
  /** Board to show. Created when missing. Defaults to the current board. */
  board?: string;
  /** Makes this session the Send target. */
  sessionId?: string;
  /** Text shown at the top of the panel, such as what Claude asked for. */
  prompt?: string;
  /** `write` opens Write mode on a new note instead of the board. Defaults to `sketch`. */
  mode?: 'sketch' | 'write';
  /** In Write mode, the new note's text. */
  text?: string;
  /** Sets the board's layout. Absent leaves it as it is. */
  layout?: BoardLayout;
}

export interface OpenResponse {
  board: string;
  /** The server's target after the request, whatever the backend returned. */
  targetSessionId?: string;
  /** True when Write mode started the new note with the request's text. */
  noteText?: boolean;
}

// ── POST /notes ───────────────────────────────────────────────────────────
// Files a note in Write mode without showing or focusing the panel. With a
// live session it goes under that session's tab, else under Notes. The open
// panel lists it at once and keeps the note it shows.

export interface NoteRequest {
  /** Markdown, as Write mode keeps it. */
  text: string;
  /** The name the note list shows. Absent, the list shows the text's first line. */
  title?: string;
  /** Files the note under this session. It must be live. */
  sessionId?: string;
}

export interface NoteResponse {
  ok: true;
  draftId: string;
}

// ── Outputs file ──────────────────────────────────────────────────────────
// `<cwd>/.feedback/outputs/<sessionId>.json`. The mod writes it; the app only
// reads it. Claude declares a deliverable with the `declare_output` tool, and
// the mod's hook on Write, Edit and NotebookEdit records every document-type
// file the session touches. One record per `ref`.

export function outputsFile(cwd: string, sessionId: string): string {
  return `${cwd}/.feedback/outputs/${sessionId}.json`;
}

/** Extensions the hook records, lower case, without the dot. */
export const DOCUMENT_EXTENSIONS: readonly string[] = ['md', 'markdown', 'mdx', 'html', 'htm', 'pdf', 'docx', 'pptx', 'xlsx'];

/** Folders under the cwd whose files are never outputs. */
export const OUTPUT_SKIP_DIRS: readonly string[] = ['.feedback', '.claude', 'node_modules'];

export type OutputKind = 'markdown' | 'html' | 'pdf' | 'docx' | 'pptx' | 'xlsx' | 'artifact' | 'other';

/** `declared` when Claude named it with `declare_output`; `detected` when only the hook saw it. */
export type OutputTier = 'declared' | 'detected';

export type OutputStatus = 'drafting' | 'ready';

/** `created` when the session made the file, or replaced most of it; `edited` otherwise. */
export type OutputOrigin = 'created' | 'edited';

export interface OutputRecord {
  /** The path relative to the session's cwd, or the URL. The record's key. */
  ref: string;
  /** Present when `ref` is a URL. */
  url?: string;
  title?: string;
  kind: OutputKind;
  tier: OutputTier;
  /** Only a declared output has a status. */
  status?: OutputStatus;
  origin?: OutputOrigin;
  /** Epoch ms of the latest `declare_output` call. */
  declaredAt?: number;
  /** Epoch ms of the hook's first and latest write. Absent for a URL. */
  firstWriteAt?: number;
  lastWriteAt?: number;
  /** How many writes the hook saw. */
  writes?: number;
}

export interface OutputsFile {
  version: 1;
  sessionId: string;
  outputs: OutputRecord[];
}

// ── Bash requests ─────────────────────────────────────────────────────────
// `agent-brief show` and `agent-brief output` print one line: this mark, then
// a BashRequest as JSON. The mod's Bash hook reads it and rewrites the output.
// This path works where an organization's policy stops plugins adding tools.

export const BASH_REQUEST_MARK = 'agent-brief:request ';

/** One picture `agent-brief show` names. `path` is absolute. */
export interface ShowRequestItem {
  path: string;
  title?: string;
}

export type BashRequest =
  | { kind: 'show'; input: { path?: string; title?: string; board?: string; url?: string; options?: ShowRequestItem[] } }
  | { kind: 'output'; input: { title: string; path?: string; url?: string; status?: OutputStatus } };

export const bashRequestLine = (request: BashRequest): string => `${BASH_REQUEST_MARK}${JSON.stringify(request)}`;

/** The request in a command's output, or undefined when it has none. */
export function bashRequestOf(stdout: string): BashRequest | undefined {
  const line = stdout.split('\n').find((l) => l.startsWith(BASH_REQUEST_MARK));
  if (line === undefined) return undefined;
  try {
    const value = JSON.parse(line.slice(BASH_REQUEST_MARK.length)) as Partial<BashRequest>;
    const isKind = value.kind === 'show' || value.kind === 'output';
    return isKind && typeof value.input === 'object' && value.input !== null ? (value as BashRequest) : undefined;
  } catch {
    return undefined;
  }
}

// ── Deliveries ────────────────────────────────────────────────────────────
// GET /deliveries?session=<id>&wait=<seconds> long-polls. It answers at once
// when deliveries are queued, else after `wait` seconds (max 30) with none.
// POST /deliveries/:id/ack removes one from the queue.

export interface Delivery {
  id: string;
  sessionId: string;
  /** Absolute path of the bundle, `<cwd>/.feedback/sketches/<id>/`. */
  dir: string;
  /** Prompt text to put in the box. Paths are relative to the session's cwd. */
  draft: string;
  /** `fill` puts the draft in the prompt box. `submit` sends it at once. */
  mode: 'fill' | 'submit';
  createdAt: number;
}

export interface DeliveriesResponse {
  deliveries: Delivery[];
}

/** An unknown id answers 200 with `acked: false`, so a retried ack is harmless. */
export interface AckResponse {
  acked: boolean;
}

// ── Boards ────────────────────────────────────────────────────────────────
// GET    /boards                         → BoardsResponse
// GET    /boards/:name/elements[?region=x,y,w,h] → ReadResponse
// GET    /boards/:name/png[?region=x,y,w,h&maxEdge=1400] → image/png
// POST   /boards/:name/draw              DrawRequest   → DrawResponse
// PATCH  /boards/:name/elements          UpdateRequest → MutateResponse
// DELETE /boards/:name/elements          DeleteRequest → MutateResponse
// :name may be `current`.

/**
 * `freeform` is the plain whiteboard. `stack` files each drop or paste of
 * screenshots as a numbered group, one group per row, newest at the bottom.
 */
export type BoardLayout = 'freeform' | 'stack';

export interface BoardsResponse {
  /** `layout` is absent for a freeform board. */
  boards: { name: string; updatedAt: number; elementCount: number; layout?: BoardLayout }[];
  current: string;
}

export type ShapeType =
  | 'rectangle'
  | 'ellipse'
  | 'diamond'
  | 'text'
  | 'sticky'
  | 'arrow'
  | 'line'
  | 'frame'
  | 'image'
  | 'freedraw';

/** Named colours keep agent drawings consistent with the palette. */
export type ColorName =
  | 'black'
  | 'gray'
  | 'red'
  | 'orange'
  | 'yellow'
  | 'green'
  | 'blue'
  | 'violet'
  | 'pink';

export type Endpoint = { id: string } | { x: number; y: number };

/** What an agent sends to draw. The app fills in defaults and layout. */
export interface Skeleton {
  /** Caller-chosen id, so arrows in the same request can bind to it. */
  id?: string;
  type: Exclude<ShapeType, 'freedraw'>;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  /** Text inside a shape, sticky or frame title. The text of a `text` element. */
  label?: string;
  color?: ColorName;
  /** Arrow and line ends. */
  start?: Endpoint;
  end?: Endpoint;
  /** Line points relative to x,y. */
  points?: [number, number][];
  /** Puts the element inside a frame. */
  frameId?: string;
  /** An `image` element's picture, as a `data:image/png|jpeg|webp|gif;base64,` URL. Needs width and height. */
  image?: string;
}

export interface DrawRequest {
  elements: Skeleton[];
}

export interface DrawResponse {
  /** Ids in request order. */
  ids: string[];
  /** One undo step removes the whole batch. */
  batchId: string;
  /** Problems the drawing has, such as an arrow its label hides. */
  warnings?: string[];
}

export interface ElementSummary {
  id: string;
  type: ShapeType;
  x: number;
  y: number;
  width: number;
  height: number;
  label?: string;
  color?: string;
  by: 'user' | 'claude';
  frameId?: string;
  /** Bound arrow ends. */
  startId?: string;
  endId?: string;
  /** Epoch ms when the element was added. */
  createdAt?: number;
}

export interface ReadResponse {
  board: string;
  elements: ElementSummary[];
  /** The scene's bounding box, for picking a region. */
  bounds: { x: number; y: number; width: number; height: number };
}

export interface ElementUpdate {
  id: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  label?: string;
  color?: ColorName;
}

export interface UpdateRequest {
  updates: ElementUpdate[];
}

export interface DeleteRequest {
  ids: string[];
}

export interface MutateResponse {
  /** Ids that changed. Unknown ids are left out. */
  ids: string[];
  batchId: string;
}
