/**
 * The Initiative slice of the companion socket protocol, until it lands in companion-protocol.ts.
 * Names and shapes match companion/src/protocol.ts. Once both copies carry them, this file goes
 * and the imports switch to './companion-protocol'.
 *
 * GET /initiatives, /initiatives/recent?limit=3 and /initiatives/find?q=<words> answer InitiativeSummary[].
 * GET /sessions/:id/initiative answers InitiativeSnapshot, or 204 while the session has none.
 * PUT /sessions/:id/initiative with SessionInitiativeRequest attaches and answers the new snapshot.
 * DELETE /sessions/:id/initiative detaches.
 */

export type InitiativeRole = 'working' | 'sources' | 'decisions' | 'grounding' | 'outputs'

export type InitiativeFolder = { path: string; role: InitiativeRole; note?: string }

export type Initiative = {
  id: string
  title: string
  /** The brief file. */
  path: string
  understanding: string
  /** Raw lines without the leading "- ". */
  decisions: string[]
  open: string[]
  folders: InitiativeFolder[]
  revision: number
  updatedAt: string
  /** "PM" or "Claude · <sessionId>". */
  updatedBy: string
  lastActiveAt: string
  /** Attached session ids. */
  sessions?: string[]
  /** True when the brief file is not found. */
  missing?: boolean
}

/** `line` is the first sentence of Understanding. `find` adds a score. */
export type InitiativeSummary = Pick<Initiative, 'id' | 'title' | 'lastActiveAt'> & { line: string; score?: number }

export type InitiativeSnapshot = {
  id: string
  title: string
  revision: number
  attachmentRevision: number
  understanding: string
  decisions: string[]
  open: string[]
  folders: InitiativeFolder[]
}

// POST /initiatives creates the brief file in `folder` and the index row.
export interface InitiativeCreateRequest {
  title: string
  folder: string
  understanding?: string
  folders?: InitiativeFolder[]
  decisions?: string[]
  open?: string[]
  /** Written as "- <row>" lines under ## Working. */
  working?: string[]
}

// PUT /initiatives/:id answers 409 on a revision mismatch.
export interface InitiativeUpdateRequest {
  revision: number
  understanding?: string
  decisions?: string[]
  open?: string[]
  folders?: InitiativeFolder[]
  updatedBy: string
}

// GET /initiatives/:id/history
export interface InitiativeRevision {
  revision: number
  updatedAt: string
  updatedBy: string
  changed?: string[]
}

// PUT /sessions/:id/initiative answers the new InitiativeSnapshot; 404 when the session is not live or the id is unknown.
// DELETE /sessions/:id/initiative answers { detached: boolean }.
export interface SessionInitiativeRequest {
  initiativeId: string
}
