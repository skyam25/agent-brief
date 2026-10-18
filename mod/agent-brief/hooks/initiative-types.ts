/**
 * The Initiative slice of the companion socket protocol, until it lands in companion-protocol.ts.
 * A copy of the Initiatives block of companion/src/protocol.ts. Once both protocol copies carry it,
 * this file goes and the imports switch to './companion-protocol'.
 */

// ── Initiatives ───────────────────────────────────────────────────────────
// An initiative is a standing brief above sessions, kept as `<Title> brief.md`
// in the initiative's own folder. Its front matter holds `agent_brief_id`, so a
// rename or move survives. The app indexes briefs in `<data>/initiatives.json`
// with revisions, session bindings and lastActiveAt. The CLI reads the index
// and the briefs directly when the app is closed. Writes need the app.
//
// GET    /initiatives                 → InitiativeSummary[], latest lastActiveAt first
// GET    /initiatives/recent?limit=3  → InitiativeSummary[]
// GET    /initiatives/find?q=<words>  → InitiativeSummary[], the top 3 with `score`
// POST   /initiatives                 InitiativeCreateRequest → Initiative
// GET    /initiatives/:id             → Initiative
// PUT    /initiatives/:id             InitiativeUpdateRequest → Initiative, 409 on a stale revision
// GET    /initiatives/:id/history     → InitiativeRevision[], newest first
// GET    /sessions/:id/initiative     → InitiativeSnapshot, or 204 when none is attached
// PUT    /sessions/:id/initiative     SessionInitiativeRequest → InitiativeSnapshot. The session must be live.
// DELETE /sessions/:id/initiative     → { detached: boolean }

/** The part a folder plays in an initiative's map. */
export type InitiativeRole = 'working' | 'sources' | 'decisions' | 'grounding' | 'outputs'

export const INITIATIVE_ROLES: readonly InitiativeRole[] = ['working', 'sources', 'decisions', 'grounding', 'outputs']

/** The most Understanding a snapshot carries. A longer one is cut and ends with `…`. */
export const INITIATIVE_UNDERSTANDING_CAP = 2400

export interface InitiativeFolder {
  /** As the brief writes it. `~/` is allowed. */
  path: string
  role: InitiativeRole
  note?: string
}

export interface Initiative {
  id: string
  title: string
  /** The brief file, absolute. */
  path: string
  understanding: string
  /** Raw lines without the leading `- `. */
  decisions: string[]
  open: string[]
  folders: InitiativeFolder[]
  revision: number
  /** ISO time of the latest revision. */
  updatedAt: string
  /** `PM` or `Claude · <sessionId>`. */
  updatedBy: string
  /** ISO time of the latest attach, update or creation. */
  lastActiveAt: string
  /** The sessions attached now. */
  sessions?: string[]
  /** True when the brief file is gone and no moved copy turned up. */
  missing?: boolean
}

export type InitiativeSummary = Pick<Initiative, 'id' | 'title' | 'lastActiveAt'> & {
  /** The first sentence of Understanding. */
  line: string
  /** Term overlap. Only `find` sets it. */
  score?: number
}

export interface InitiativeSnapshot {
  id: string
  title: string
  revision: number
  /** Bumps on every attach to this session, so a re-attach sends the snapshot again. */
  attachmentRevision: number
  /** At most INITIATIVE_UNDERSTANDING_CAP characters. */
  understanding: string
  decisions: string[]
  open: string[]
  folders: InitiativeFolder[]
}

export interface InitiativeRevision {
  revision: number
  updatedAt: string
  updatedBy: string
  /** The sections the revision changed, such as `understanding`. Absent for an edit made outside the app. */
  changed?: string[]
}

export interface InitiativeCreateRequest {
  title: string
  /** Absolute folder the brief goes in. Created when missing. */
  folder: string
  understanding?: string
  /** Defaults to the folder as `working`. */
  folders?: InitiativeFolder[]
  decisions?: string[]
  open?: string[]
  /** Rows for the Working section, without the leading `- `. */
  working?: string[]
  /** Defaults to `PM`. */
  updatedBy?: string
}

export interface InitiativeUpdateRequest {
  /** The revision the change was made against. */
  revision: number
  understanding?: string
  decisions?: string[]
  open?: string[]
  folders?: InitiativeFolder[]
  updatedBy: string
}

export interface SessionInitiativeRequest {
  initiativeId: string
}

export interface DetachInitiativeResponse {
  detached: boolean
}
