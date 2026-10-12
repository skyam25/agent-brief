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
  /** Where the session runs, for its label and for jumping back to it. */
  host?: SessionHost
  /** Set by the app. True when the user asked Claude to keep an items file for this session. */
  trackItems?: boolean
  /** Set by the app when tracking is on: `<cwd>/.feedback/items/<sessionId>.md`. */
  itemsPath?: string
}

// GET /sessions/:id → SessionInfo. PATCH /sessions/:id with TrackingPatch → SessionInfo.
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
}

export interface OpenResponse {
  board: string
  targetSessionId?: string
  noteText?: boolean
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
