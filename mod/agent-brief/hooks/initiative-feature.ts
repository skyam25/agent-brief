/** Owns initiative attachment, prompt snapshots and compaction invalidation. */
import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'
import {
  INITIATIVE_APP_DOWN,
  INITIATIVE_NONE,
  INITIATIVE_NOT_RUNNING,
  LISTED_LIMIT,
  NOT_ATTACHED,
  RECENT_LIMIT,
  attachPrompt,
  attachedToast,
  attachedOf,
  choiceOf,
  detachedNote,
  detachedText,
  discoverPrompt,
  draftPrompt,
  injectionText,
  parseInitiativeArgs,
  pickChoices,
  recentInitiativesPath,
  recentLine,
  refreshedText,
  sessionInitiativePath,
  shouldInject,
  snapshotOf,
  summariesOf,
  tokenOf,
} from './initiative'
import type { InitiativeSnapshot, SessionInitiativeRequest } from './companion-protocol'

const initiativeRef = atom({ plugin: 'agent-brief', key: 'initiative' } as const, null)
const recentRef = atom({ plugin: 'agent-brief', key: 'recentInitiatives' } as const, [])
const sentRef = atom({ plugin: 'agent-brief', key: 'initiativeSent' } as const, null)
const staleRef = atom({ plugin: 'agent-brief', key: 'isInitiativeStale' } as const, false)
const recentDoneRef = atom({ plugin: 'agent-brief', key: 'isRecentLineDone' } as const, false)
const refusedRef = atom({ plugin: 'agent-brief', key: 'initiativeRefusals' } as const, 0)
// Engine refs are discovered per file; these keys are shared with their existing owners.
const outputsRef = atom({ plugin: 'agent-brief', key: 'outputs' } as const, [])
const pickingRef = atom({ plugin: 'agent-brief', key: 'picking' } as const, 'none')

/**
 * Counts the attaches and detaches this session started. A read that began before one is stale,
 * so `fetchInitiative` drops it rather than overwrite the newer pick.
 */
let changes = 0

export interface InitiativeEnvironment {
  request: (method: string, path: string, body?: unknown) => Promise<{ ok: boolean; status: number; body: unknown } | undefined>
  home: () => Promise<string>
  ready: () => Promise<boolean>
  isUp: boolean
  submit: (text: string) => void
}

/** Keeps unchanged attachment state stable so views do not redraw. */
async function keepInitiative($: EngineInterface, snapshot: InitiativeSnapshot | null): Promise<void> {
  const next = snapshot === null ? null : attachedOf(snapshot)
  await update($, initiativeRef, held => {
    if (held === null || next === null) return held === next ? held : next
    return tokenOf(held) === tokenOf(next) && held.title === next.title ? held : next
  })
}

/**
 * This session's initiative as the app holds it. Null when it has none: a 204, or a 404 from an app without initiatives.
 * Undefined when the app did not answer, or a pick overtook the read, which leaves the kept value alone.
 */
export async function fetchInitiative($: EngineInterface, env: InitiativeEnvironment): Promise<InitiativeSnapshot | null | undefined> {
  const seen = changes
  const reply = await env.request('GET', sessionInitiativePath(await $.session.id()))
  if (reply === undefined || seen !== changes) return undefined
  const snapshot = reply.ok ? (snapshotOf(reply.body) ?? null) : reply.status === 404 ? null : undefined
  if (snapshot !== undefined) await keepInitiative($, snapshot)
  return snapshot
}

/** Reads enough initiatives for the Brief pane's Select. The band and the first prompt's line take the first few. */
export async function loadRecent($: EngineInterface, env: InitiativeEnvironment): Promise<void> {
  const reply = await env.request('GET', recentInitiativesPath(LISTED_LIMIT))
  if (reply?.ok) await update($, recentRef, () => summariesOf(reply.body).map(choiceOf))
}

/** Runs when the session registers and when the Brief pane opens: the recent initiatives, and any attachment the app holds. */
export async function loadInitiative($: EngineInterface, env: InitiativeEnvironment): Promise<void> {
  await loadRecent($, env)
  await fetchInitiative($, env)
}

/** What a prompt carries after the user's text. `sent` is what to record once the prompt entered; null clears the record. */
export type Appended = { context: string[]; sent?: { token: string; title: string } | null }

/**
 * The snapshot when its token moved or a compaction dropped it. A detach since the last snapshot gets one note.
 * With nothing attached and `wantsRecent` set, one line naming the recent initiatives.
 */
export async function initiativeContext($: EngineInterface, env: InitiativeEnvironment): Promise<Appended> {
  const wantsRecent = !(await read($, recentDoneRef))
  const snapshot = env.isUp ? await fetchInitiative($, env) : undefined
  const sessionId = await $.session.id()
  const held = await read($, sentRef)
  const sent = held?.sessionId === sessionId ? held : undefined
  if (snapshot) {
    const token = tokenOf(snapshot)
    if (!shouldInject(token, sent?.token, await read($, staleRef))) return { context: [] }
    return { context: [injectionText(snapshot)], sent: { token, title: snapshot.title } }
  }
  if (snapshot === null && sent !== undefined) return { context: [detachedNote(sent.title)], sent: null }
  if (snapshot === null && wantsRecent) {
    const line = recentLine(await read($, recentRef))
    if (line !== undefined) return { context: [line] }
  }
  return { context: [] }
}

async function recordSent($: EngineInterface, sent: { token: string; title: string } | null): Promise<void> {
  const sessionId = await $.session.id()
  await update($, sentRef, () => (sent === null ? null : { sessionId, ...sent }))
  if (sent !== null) await update($, staleRef, () => false)
}

/** Submits a prompt for Claude once the command's answer has shown. A command.run hook cannot submit itself. */
function handToClaude($: EngineInterface, env: InitiativeEnvironment, text: string): void {
  $.clock.after(0, () => env.submit(text))
}

/**
 * Answers `/initiative`. Drafting, attaching by name and Discover go to Claude with the CLI calls to run.
 * `off` and `refresh` are the mod's own, so they cost no turn. Never starts the app.
 */
export async function initiativeCommand($: EngineInterface, env: InitiativeEnvironment, args: string): Promise<{ text: string; context?: string[] }> {
  const parsed = parseInitiativeArgs(args)
  const sessionId = await $.session.id()
  if (parsed.kind === 'discover') {
    handToClaude($, env, discoverPrompt(await env.home(), sessionId))
    return { text: 'Asking Claude to survey this folder for initiatives…' }
  }
  if (!(await env.ready())) return { text: INITIATIVE_NOT_RUNNING }
  if (parsed.kind === 'attach') {
    handToClaude($, env, attachPrompt(parsed.name, sessionId))
    return { text: `Asking Claude to attach ${parsed.name}…` }
  }
  if (parsed.kind === 'draft') {
    await loadRecent($, env)
    handToClaude($, env, draftPrompt({ sessionId, cwd: await env.home(), outputs: await read($, outputsRef), recent: (await read($, recentRef)).slice(0, RECENT_LIMIT) }))
    return { text: 'Asking Claude to draft an initiative from this session…' }
  }
  const snapshot = await fetchInitiative($, env)
  if (snapshot === undefined) return { text: INITIATIVE_NOT_RUNNING }
  if (snapshot === null) return { text: INITIATIVE_NONE }
  if (parsed.kind === 'refresh') {
    await recordSent($, { token: tokenOf(snapshot), title: snapshot.title })
    return { text: refreshedText(snapshot), context: [injectionText(snapshot)] }
  }
  const reply = await env.request('DELETE', sessionInitiativePath(sessionId))
  if (!reply?.ok) return { text: `Agent Brief did not detach ${snapshot.title}.` }
  await keepInitiative($, null)
  await recordSent($, null)
  return { text: detachedText(snapshot.title), context: [detachedNote(snapshot.title)] }
}

/** The band's picker and the Brief pane's Select: attaches this session to the picked initiative. */
export async function attachFromBand($: EngineInterface, env: InitiativeEnvironment, initiativeId: string): Promise<void> {
  changes++
  await update($, pickingRef, () => 'none')
  if (!(await env.ready())) {
    await refused($, env, INITIATIVE_APP_DOWN)
    return
  }
  const body: SessionInitiativeRequest = { initiativeId }
  const reply = await env.request('PUT', sessionInitiativePath(await $.session.id()), body)
  const snapshot = reply?.ok ? snapshotOf(reply.body) : undefined
  if (snapshot === undefined) {
    await refused($, env, NOT_ATTACHED)
    return
  }
  await keepInitiative($, snapshot)
  $.ui.toast(attachedToast(snapshot.title), { timeoutMs: 8000 })
}

/**
 * A change the app refused. The pane's Select keeps a pick until it draws a new value, so it gets a new key
 * and draws the attachment the app still holds.
 */
async function refused($: EngineInterface, env: InitiativeEnvironment, text: string): Promise<void> {
  await fetchInitiative($, env).catch(() => undefined)
  await update($, refusedRef, n => n + 1)
  $.ui.toast(text, { timeoutMs: 8000 })
}

/** The picker's Detach, or None in the Brief pane's Select. Claude reads a note about it with the next prompt. */
export async function detachFromBand($: EngineInterface, env: InitiativeEnvironment): Promise<void> {
  changes++
  await update($, pickingRef, () => 'none')
  const title = (await read($, initiativeRef))?.title
  const reply = await env.request('DELETE', sessionInitiativePath(await $.session.id()))
  if (!reply?.ok) {
    await refused($, env, reply === undefined ? INITIATIVE_APP_DOWN : `Agent Brief did not detach ${title ?? 'the initiative'}.`)
    return
  }
  await keepInitiative($, null)
  $.ui.toast(detachedText(title), { timeoutMs: 8000 })
}


export async function initiativeView($: EngineInterface) {
  const initiative = await read($, initiativeRef)
  const recent = await read($, recentRef)
  return {
    initiative,
    choices: pickChoices(initiative, recent),
    listed: pickChoices(initiative, recent, LISTED_LIMIT),
    /** How many changes the app refused, which keys the pane's Select afresh. */
    refusals: await read($, refusedRef),
  }
}
export function markInitiativeResumed($: EngineInterface) { return update($, recentDoneRef, () => true) }
export function invalidateInitiative($: EngineInterface) { return update($, staleRef, () => true) }
export async function recordInitiativePrompt($: EngineInterface, appended: Appended): Promise<void> {
  if (appended.sent !== undefined) await recordSent($, appended.sent)
  if (appended.context.length > 0) await update($, recentDoneRef, () => true)
}
