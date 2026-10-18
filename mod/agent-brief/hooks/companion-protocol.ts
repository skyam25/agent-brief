/**
 * The slice of the companion socket protocol this mod speaks.
 * Copied from companion/src/protocol.ts (PROTOCOL_VERSION 1). Keep in step with it.
 * The protocol only adds fields and routes.
 * Errors use `{ error, code }`. A body over 20 MB gets 413. A request with a body,
 * DELETE included, must send Content-Length.
 */

export const PROTOCOL_VERSION = 1

/** `~/Library/Application Support/AgentBrief/agent-brief.sock`, file mode 0600. */
export function defaultSocketPath(home: string): string {
  return `${home}/Library/Application Support/AgentBrief/agent-brief.sock`
}

// GET /health
export interface Health {
  ok: true
  version: number
  pid: number
  panelVisible: boolean
  currentBoard: string
}

// POST /sessions answers SessionsResponse. DELETE /sessions/:id answers RemoveSessionResponse.
export interface SessionInfo {
  sessionId: string
  cwd: string
  title?: string
  pid?: number
  /** The user's latest typed prompt, trimmed. */
  summary?: string
  /** Epoch ms when the session last finished a reply. Absent before its first one. */
  activeAt?: number
  /** Where the session runs, for its label and for jumping back to it. */
  host?: SessionHost
  /** Set by the app. True when the user asked Claude to keep an items file for this session. */
  trackItems?: boolean
  /** Set by the app when tracking is on: `<cwd>/.feedback/items/<sessionId>.md`. */
  itemsPath?: string
  /** Set by the app for a live session: `<cwd>/.feedback/outputs/<sessionId>.json`, where the mod records outputs. */
  outputsPath?: string
  /** The session's mode, mirrored from the mod. Absent means default. */
  mode?: SessionMode
  /** The prototype fidelity, mirrored from the mod. Only set with `mode: 'prototype'`. */
  fidelity?: PrototypeFidelity
}

export type SessionMode = 'default' | 'product' | 'prototype' | 'orchestrate'

export type PrototypeFidelity = 'wireframe' | 'styled' | 'live-patch' | 'freeze-patch' | 'interactive' | 'existing'

/** PATCH /sessions/:id body. The app stores and shows the mode; it never sets it. */
export interface ModePatch {
  mode: SessionMode
  fidelity?: PrototypeFidelity
}

// GET /sessions/:id → SessionInfo. PATCH /sessions/:id with TrackingPatch | ModePatch → SessionInfo.
export interface TrackingPatch {
  trackItems: boolean
}

export interface SessionHost {
  /** `TERM_PROGRAM`. */
  terminal?: string
  /** Bundle id of the app the terminal runs in, from `__CFBundleIdentifier`. */
  bundleId?: string
  /** herdr pane id, from `HERDR_PANE_ID`. */
  herdrPane?: string
}

export interface SessionsResponse {
  sessions: SessionInfo[]
  targetSessionId?: string
}

export interface RemoveSessionResponse {
  removed: boolean
}

// POST /open
export interface OpenRequest {
  board?: string
  sessionId?: string
  prompt?: string
  mode?: 'sketch' | 'write'
  /** Sets the board's layout. Absent leaves it as it is. */
  layout?: BoardLayout
  /** Opens this output of `sessionId` instead of a board: a Markdown file as a note in Write, an HTML file in the review pane. Project-relative. Needs `sessionId`. */
  output?: { path: string }
}

/** `stack` files each drop or paste of screenshots as a numbered group. `freeform` is the plain whiteboard. */
export type BoardLayout = 'freeform' | 'stack'

export interface OpenResponse {
  board: string
  targetSessionId?: string
  noteText?: boolean
  /** What the panel shows now: the board, a note in Write, or an HTML file in the review pane. */
  opened?: 'board' | 'note' | 'review'
}

// POST /notes files a note in Write mode without showing or focusing the panel.
// With a live session it goes under that session's tab, else under Notes.
export interface NoteRequest {
  /** Markdown, as Write mode keeps it. */
  text: string
  /** The name the note list shows. Absent, the list shows the text's first line. */
  title?: string
  /** Files the note under this session. It must be live. */
  sessionId?: string
}

export interface NoteResponse {
  ok: true
  draftId: string
}

// GET /deliveries?session=<id>&wait=<seconds>, POST /deliveries/:id/ack
export interface Delivery {
  id: string
  sessionId: string
  dir: string
  draft: string
  mode: 'fill' | 'submit'
  createdAt: number
}

export interface DeliveriesResponse {
  deliveries: Delivery[]
}

/** An unknown id answers 200 with `acked: false`, so a retried ack is harmless. */
export interface AckResponse {
  acked: boolean
}

// ── Outputs file ──────────────────────────────────────────────────────────
// `<cwd>/.feedback/outputs/<sessionId>.json`. The mod writes it; the app only
// reads it. Claude declares a deliverable with the `declare_output` tool, and
// the mod's hook on Write, Edit and NotebookEdit records every document-type
// file the session touches. One record per `ref`.

export function outputsFile(cwd: string, sessionId: string): string {
  return `${cwd}/.feedback/outputs/${sessionId}.json`
}

/** Extensions the hook records, lower case, without the dot. */
export const DOCUMENT_EXTENSIONS: readonly string[] = ['md', 'markdown', 'mdx', 'html', 'htm', 'pdf', 'docx', 'pptx', 'xlsx']

/** Folders under the cwd whose files are never outputs. */
export const OUTPUT_SKIP_DIRS: readonly string[] = ['.feedback', '.claude', 'node_modules']

export type OutputKind = 'markdown' | 'html' | 'pdf' | 'docx' | 'pptx' | 'xlsx' | 'artifact' | 'other'

/** `declared` when Claude named it with `declare_output`; `detected` when only the hook saw it. */
export type OutputTier = 'declared' | 'detected'

export type OutputStatus = 'drafting' | 'ready'

/** `created` when the session made the file, or replaced most of it; `edited` otherwise. */
export type OutputOrigin = 'created' | 'edited'

export interface OutputRecord {
  /** The path relative to the session's cwd, or the URL. The record's key. */
  ref: string
  /** Present when `ref` is a URL. */
  url?: string
  title?: string
  kind: OutputKind
  tier: OutputTier
  /** Only a declared output has a status. */
  status?: OutputStatus
  origin?: OutputOrigin
  /** Epoch ms of the latest `declare_output` call. */
  declaredAt?: number
  /** Epoch ms of the hook's first and latest write. Absent for a URL. */
  firstWriteAt?: number
  lastWriteAt?: number
  /** How many writes the hook saw. */
  writes?: number
}

export interface OutputsFile {
  version: 1
  sessionId: string
  outputs: OutputRecord[]
}

// ── Bash requests ─────────────────────────────────────────────────────────
// `agent-brief show` and `agent-brief output` print one line: this mark, then
// a BashRequest as JSON. The mod's Bash hook reads it and rewrites the output.
// This path works where an organization's policy stops plugins adding tools.

export const BASH_REQUEST_MARK = 'agent-brief:request '

/** One picture `agent-brief show` names. `path` is absolute. */
export interface ShowRequestItem {
  path: string
  title?: string
}

export type BashRequest =
  | { kind: 'show'; input: { path?: string; title?: string; board?: string; url?: string; options?: ShowRequestItem[] } }
  | { kind: 'output'; input: { title: string; path?: string; url?: string; status?: OutputStatus } }

export const bashRequestLine = (request: BashRequest): string => `${BASH_REQUEST_MARK}${JSON.stringify(request)}`

/** The request in a command's output, or undefined when it has none. */
export function bashRequestOf(stdout: string): BashRequest | undefined {
  const line = stdout.split('\n').find(l => l.startsWith(BASH_REQUEST_MARK))
  if (line === undefined) return undefined
  try {
    const value = JSON.parse(line.slice(BASH_REQUEST_MARK.length)) as Partial<BashRequest>
    const isKind = value.kind === 'show' || value.kind === 'output'
    return isKind && typeof value.input === 'object' && value.input !== null ? (value as BashRequest) : undefined
  } catch {
    return undefined
  }
}
