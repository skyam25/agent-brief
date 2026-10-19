import type { AttachedInitiative, BriefOutput, InitiativeChoice } from '../types'
import { INITIATIVE_ROLES, INITIATIVE_UNDERSTANDING_CAP } from './companion-protocol'
import type { InitiativeFolder, InitiativeRole, InitiativeSnapshot, InitiativeSummary } from './companion-protocol'

/** Opens and closes the snapshot appended after the user's prompt. */
export const INITIATIVE_MARK = '--- Agent Brief initiative ---'

export const RECENT_LIMIT = 3
/** How many initiatives the Brief pane's Select lists. */
export const LISTED_LIMIT = 20
/** The band's change row cuts titles past this. */
const TITLE_COLUMNS = 24

export const INITIATIVE_USAGE = 'Usage: /initiative [<name> | off | refresh | discover]'
export const INITIATIVE_NOT_RUNNING = 'Agent Brief is not running. Start it, then run /initiative again.'
export const INITIATIVE_NONE = 'This session has no initiative. Run /initiative <name> to attach one.'

export const INITIATIVE_COMMAND_SPEC = {
  name: 'initiative',
  description: 'Attach this session to an Agent Brief initiative: draft one from the session, name one, off, refresh or discover',
  argumentHint: '[<name> | off | refresh | discover]',
}

export function sessionInitiativePath(sessionId: string): string {
  return `/sessions/${encodeURIComponent(sessionId)}/initiative`
}

export const recentInitiativesPath = (limit = RECENT_LIMIT): string => `/initiatives/recent?limit=${limit}`

// ── Command ───────────────────────────────────────────────────────────────

export type InitiativeArgs =
  | { kind: 'draft' }
  | { kind: 'attach'; name: string }
  | { kind: 'off' }
  | { kind: 'refresh' }
  | { kind: 'discover' }

/** A bare `/initiative` drafts one from the session. Any other text names the initiative to attach. */
export function parseInitiativeArgs(args: string): InitiativeArgs {
  const text = args.trim()
  const word = text.toLowerCase()
  if (text === '') return { kind: 'draft' }
  if (word === 'off' || word === 'refresh' || word === 'discover') return { kind: word }
  return { kind: 'attach', name: text }
}

/** Quotes a value for the shell commands the prompts hand Claude. */
const quoted = (value: string) => `"${value.replace(/(["\\$`])/g, '\\$1')}"`

/** What `/initiative` hands Claude to draft an initiative from this session, create it, then attach. */
export function draftPrompt(input: {
  sessionId: string
  cwd: string
  outputs: readonly BriefOutput[]
  recent: readonly InitiativeChoice[]
}): string {
  const ready = input.outputs.filter(o => o.tier === 'declared' && o.status === 'ready')
  const readyText = ready.length === 0 ? 'none' : ready.map(o => `${o.title ?? o.ref} (${o.ref})`).join('; ')
  const recentText = input.recent.length === 0 ? 'none' : input.recent.map(r => r.title).join(', ')
  return `Draft an Agent Brief initiative from this session, as the initiative-brief skill's "New initiative" steps say.

- Session: ${input.sessionId}. Project folder: ${input.cwd}.
- Ready outputs, for the Working rows: ${readyText}.
- Recent initiatives: ${recentText}. If this work belongs to one of them, say so and offer \`/initiative <name>\` instead of creating another.

Draft a title, a short Understanding, Working rows from the Ready outputs and a folder map. Show the draft in a few lines. Ask where the brief should live only when the session does not make it clear. Then write the draft as JSON and run:

\`\`\`bash
agent-brief initiative create "<title>" --folder <folder> --file <draft.json>
agent-brief initiative attach <id> --session ${input.sessionId}
\`\`\`

Reply in one line with the title and where the brief file is.`
}

/** What `/initiative <name>` hands Claude. The user's naming wins over any match Claude would make. */
export function attachPrompt(name: string, sessionId: string): string {
  return `Attach this session to the Agent Brief initiative the user named: ${quoted(name)}. The user's choice wins over your own match.

Run \`agent-brief initiative attach ${quoted(name)} --session ${sessionId}\`. If nothing matches, run \`agent-brief initiative find ${quoted(name)}\`. Attach the one clear match, or list the candidates and ask which. Reply in one line with the title attached.`
}

/** What `/initiative discover` hands Claude. It creates nothing until the user picks. */
export function discoverPrompt(cwd: string, sessionId: string): string {
  return `Run Discover from the initiative-brief skill over ${cwd}: survey the folder and list the likely initiatives.

Run \`agent-brief initiative list\` first and leave out initiatives that already exist. Give each candidate a title, one line on why, and its folders by role. Create nothing until the user picks one. Then create it as the "New initiative" steps say and attach this session (${sessionId}).`
}

export const detachedText = (title: string | undefined) =>
  title === undefined ? 'Detached. Agent Brief adds nothing more to your prompts.' : `Detached from ${title}. Agent Brief adds nothing more to your prompts.`

/** The note Claude reads after `/initiative off`. */
export const detachedNote = (title: string | undefined) =>
  `This session is no longer attached to ${title === undefined ? 'its Agent Brief initiative' : `the Agent Brief initiative ${title}`}. Stop maintaining its brief.`

export const INITIATIVE_APP_DOWN = 'Agent Brief is not running. Start it to change the initiative.'
export const NOT_ATTACHED = 'Agent Brief did not attach that initiative.'
export const attachedToast = (title: string) => `Attached ${title}. Claude gets its brief with your next prompt.`

export const refreshedText =(s: InitiativeSnapshot) => `Sent the ${s.title} brief to Claude (revision ${s.revision}).`

// ── Snapshot and injection ────────────────────────────────────────────────

/** Changes whenever the session attaches again or the brief gains a revision. */
export function tokenOf(s: Pick<InitiativeSnapshot, 'attachmentRevision' | 'id' | 'revision'>): string {
  return `${s.attachmentRevision}:${s.id}:${s.revision}`
}

/** True when the prompt should carry the snapshot: the token moved, or a compaction dropped the last one. */
export function shouldInject(token: string, sent: string | undefined, isStale: boolean): boolean {
  return isStale || token !== sent
}

const isText = (value: unknown): value is string => typeof value === 'string' && value.trim() !== ''
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const lines = (value: unknown): string[] => (Array.isArray(value) ? value.filter(isText) : [])

function folderOf(raw: unknown): InitiativeFolder | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const { path, role, note } = raw as Record<string, unknown>
  if (!isText(path) || !(INITIATIVE_ROLES as readonly unknown[]).includes(role)) return undefined
  return { path, role: role as InitiativeRole, ...(isText(note) ? { note } : {}) }
}

/** The snapshot in a GET or PUT /sessions/:id/initiative answer, or undefined when the body is not one. */
export function snapshotOf(body: unknown): InitiativeSnapshot | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const b = body as Record<string, unknown>
  if (!isText(b.id) || !isText(b.title) || !isCount(b.revision) || !isCount(b.attachmentRevision)) return undefined
  return {
    id: b.id,
    title: b.title,
    revision: b.revision,
    attachmentRevision: b.attachmentRevision,
    understanding: typeof b.understanding === 'string' ? b.understanding : '',
    decisions: lines(b.decisions),
    open: lines(b.open),
    folders: Array.isArray(b.folders) ? b.folders.map(folderOf).filter(f => f !== undefined) : [],
  }
}

/** The summaries in a list answer: a bare array, or one under `initiatives`. */
export function summariesOf(body: unknown): InitiativeSummary[] {
  const list = Array.isArray(body) ? body : (body as { initiatives?: unknown } | null)?.initiatives
  if (!Array.isArray(list)) return []
  return list.flatMap(raw => {
    if (typeof raw !== 'object' || raw === null) return []
    const { id, title, line, lastActiveAt } = raw as Record<string, unknown>
    if (!isText(id) || !isText(title)) return []
    return [{ id, title, line: typeof line === 'string' ? line : '', lastActiveAt: typeof lastActiveAt === 'string' ? lastActiveAt : '' }]
  })
}

export const choiceOf = (s: Pick<InitiativeSummary, 'id' | 'title' | 'line'>): InitiativeChoice => ({ id: s.id, title: s.title, line: s.line })

export const attachedOf = (s: InitiativeSnapshot): AttachedInitiative => ({
  id: s.id,
  title: s.title,
  revision: s.revision,
  attachmentRevision: s.attachmentRevision,
})

/** The app caps the snapshot too. This holds the line against an app that does not. */
export function capUnderstanding(text: string): string {
  const trimmed = text.trim()
  const cap = INITIATIVE_UNDERSTANDING_CAP
  return trimmed.length <= cap ? trimmed : `${trimmed.slice(0, cap - 1).trimEnd()}…`
}

/** True when the app or the mod cut Understanding at the cap, so the snapshot holds only its start. */
export function isUnderstandingCut(raw: string): boolean {
  const capped = capUnderstanding(raw)
  return capped.endsWith('…') || capped.length === INITIATIVE_UNDERSTANDING_CAP
}

/** The snapshot as appended after the user's prompt, between the markers, with a one-line pointer to the skill. */
export function injectionText(s: InitiativeSnapshot): string {
  const list = (heading: string, rows: readonly string[]) => (rows.length === 0 ? [] : ['', `## ${heading}`, ...rows.map(r => `- ${r}`)])
  const understanding = capUnderstanding(s.understanding)
  const cutNote = isUnderstandingCut(s.understanding)
    ? [`Understanding below is cut short. Run \`agent-brief initiative show ${s.id}\` for the full text before you rewrite it.`]
    : []
  return [
    INITIATIVE_MARK,
    `This session is attached to the initiative ${s.title} (id ${s.id}, revision ${s.revision}). This snapshot replaces any earlier one.`,
    `Keep its brief current as the initiative-brief skill says, with \`agent-brief initiative update ${s.id} --file <json>\` at revision ${s.revision}.`,
    ...cutNote,
    '',
    '## Understanding',
    understanding === '' ? '(empty)' : understanding,
    ...list('Decisions', s.decisions),
    ...list('Open', s.open),
    ...list('Folders', s.folders.map(f => `${f.path} → ${f.role}${f.note ? ` · ${f.note}` : ''}`)),
    INITIATIVE_MARK,
  ].join('\n')
}

/** The one line the session's first prompt carries while no initiative is attached. Undefined when there are none. */
export function recentLine(recent: readonly Pick<InitiativeChoice, 'title'>[]): string | undefined {
  if (recent.length === 0) return undefined
  const titles = recent.slice(0, RECENT_LIMIT).map(r => r.title).join(', ')
  return `Agent Brief · recent initiatives: ${titles}. If this work belongs to one, run agent-brief initiative attach <name>.`
}

// ── Band ──────────────────────────────────────────────────────────────────

export const bandTitle = (title: string) => (title.length <= TITLE_COLUMNS ? title : `${title.slice(0, TITLE_COLUMNS - 1).trimEnd()}…`)

/** The attached initiative first, then the recent ones, up to `limit`. The band's picker takes four. */
export function pickChoices(attached: AttachedInitiative | null, recent: readonly InitiativeChoice[], limit = RECENT_LIMIT + 1): { id: string; title: string }[] {
  const rows = attached === null ? [] : [{ id: attached.id, title: attached.title }]
  for (const r of recent) if (!rows.some(row => row.id === r.id)) rows.push({ id: r.id, title: r.title })
  return rows.slice(0, limit)
}

/** True for a shell command that runs an `agent-brief initiative` verb, after which the band reads the attachment again. */
export function isInitiativeCommand(command: unknown): boolean {
  return typeof command === 'string' && /agent-brief"?\s+initiative\b/.test(command)
}
