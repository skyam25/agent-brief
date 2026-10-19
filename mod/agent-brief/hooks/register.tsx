import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { FeedbackInboxSession, PrototypeFidelity, SessionMode } from '../types'
import { bandTree } from './band'
import type { BandRow, BandView } from './band'
import { briefTree } from './brief'
import type { BriefPaneView } from './brief'
import {
  BRIEF_COLUMNS,
  BRIEF_ROWS,
  BRIEF_PANE,
  NOTHING_HELD,
  NO_ITEMS_FILE,
  OUTPUT_NEEDS_UPDATE,
  briefBandLabel,
  briefCounts,
  dropAnswer,
  droppedText,
  feedbackFileOf,
  hasUserPrompt,
  heldDecisions,
  holdAnswer,
  isOutputOpened,
  openFeedback,
  openTarget,
  projectName,
} from './brief-logic'
import { INITIATIVE_COMMAND_SPEC } from './initiative'
import {
  loadInitiative, loadRecent, initiativeContext, initiativeCommand, attachFromBand, detachFromBand,
  fetchInitiative, initiativeView, markInitiativeResumed, invalidateInitiative,
  recordInitiativePrompt, type Appended, type InitiativeEnvironment,
} from './initiative-feature'
import { isInitiativeCommand } from './initiative'
import { decisionsDraft, itemsFile, itemsRelPath, parseItems, withDecisions } from './items-file'
import {
  countEvents,
  expandHome,
  feedbackPrompt,
  latestText,
  listText,
  markConsumed,
  parseIngestOutput,
  pickSession,
  upsert,
} from './logic'
import {
  FILL_RETRY_MS,
  ITEMS_SECTION,
  LAUNCH_ATTEMPTS,
  LAUNCH_STEP_S,
  POLL_GAP_MS,
  REREGISTER_MS,
  keepReply,
  upkeep,
  replyEndingWith,
  SKETCH_OPENED,
  STACK_OPENED,
  TRACK_NOT_RUNNING,
  TRACK_UNSUPPORTED,
  TRACK_USAGE,
  WRITE_OPENED,
  deliveriesPath,
  expandPastes,
  fillRequest,
  itemsInstructions,
  lastReply,
  launchFailureText,
  nextBackoff,
  parseDeliveries,
  parseJson,
  rememberPaste,
  hostOf,
  sessionInfo,
  sessionPath,
  socketPathOf,
  summaryOf,
  toastFor,
  trackReply,
  trackTarget,
  trackingOf,
} from './companion-logic'
import type { Tracking } from './companion-logic'
import { outputsFile } from './companion-protocol'
import type { BoardLayout, Delivery, OpenRequest, TrackingPatch } from './companion-protocol'
import {
  MODE_SECTION,
  MODE_USAGE,
  modeFilePaths,
  modePatch,
  modeReport,
  modeToast,
  parseModeArgs,
  parseModeFile,
  sectionText,
} from './modes'
import type { ModeChoice } from './modes'
import { registerModeGuard } from './mode-guard'
import { DECLARE_TOOL, OUTPUTS_SECTION, outputsInstructions, parseOutputsFile } from './outputs'
import { registerOutputs } from './outputs-file'
import { questionsTree, registerQuestions } from './questions'
import {
  ASK_TOOL,
  ASK_TOOL_SPEC,
  GRILL_COMMAND_SPEC,
  GRILL_SECTION,
  NOTHING_ANSWERED,
  answerQuestion,
  answersMessage,
  grillInstructions,
  openOther,
  typeOther,
} from './questions-logic'
import {
  PROBE_KEY,
  SHOW_COMMAND_SPEC,
  SHOW_TOOL_SPEC,
  boardOfKey,
  needsProbe,
  noteProbe,
  noteShowToolRefused,
  registerShow,
  showSection,
  startShow,
} from './show'
import type { ShowEnvironment } from './show'
import { CLEAR_PIXEL } from './show-logic'
import {
  DICTATE_ARGV,
  DICTATION_EMPTY,
  dictationFill,
  DICTATION_MAX_MS,
  DICTATION_NO_BOX,
  YAP_MISSING,
  YAP_MISSING_TEXT,
  addSecond,
  failureText,
  listening,
  splitDictation,
} from './voice'

/** The band's picture probe is waiting for its answer. */
let isBandProbing = false

type Config = {
  inboxDir: string
  nodePath: string
  transcriber: string
  whisperModel: string
}

const sessionsRef = atom({ plugin: 'agent-brief', key: 'sessions' } as const, [])
const ingestingRef = atom({ plugin: 'agent-brief', key: 'ingesting' } as const, null)
const trackingRef = atom({ plugin: 'agent-brief', key: 'tracking' } as const, false)
const MODE_STATE = { plugin: 'agent-brief', key: 'mode' } as const
const modeRef = atom(MODE_STATE, 'default')
const fidelityRef = atom({ plugin: 'agent-brief', key: 'fidelity' } as const, null)
const pickingRef = atom({ plugin: 'agent-brief', key: 'picking' } as const, 'none')
const repliesRef = atom({ plugin: 'agent-brief', key: 'replies' } as const, [])
const voiceRef = atom({ plugin: 'agent-brief', key: 'voice' } as const, null)
const homeRef = atom({ plugin: 'agent-brief', key: 'home' } as const, null)
/** When the main loop last finished a reply, so the app can tell a busy session from an idle one. */
const activeAtRef = atom({ plugin: 'agent-brief', key: 'activeAt' } as const, null)
const hasPromptedRef = atom({ plugin: 'agent-brief', key: 'hasPrompted' } as const, false)
const outputsRef = atom({ plugin: 'agent-brief', key: 'outputs' } as const, [])
const itemsRef = atom({ plugin: 'agent-brief', key: 'items' } as const, null)
const feedbackRef = atom({ plugin: 'agent-brief', key: 'feedback' } as const, {})
const answersRef = atom({ plugin: 'agent-brief', key: 'answers' } as const, [])
const briefRef = atom({ plugin: 'agent-brief', key: 'brief' } as const, { isPrototypePending: false, isTouchedOpen: false, isDoneOpen: false, isExpanded: false })
const questionsRef = atom({ plugin: 'agent-brief', key: 'questions' } as const, [])
const grillingRef = atom({ plugin: 'agent-brief', key: 'grilling' } as const, false)

const INGEST_TIMEOUT_MS = 10 * 60_000

type CompanionConfig = {
  companionSocket: string
  companionLaunch: string
}

type Reply = { ok: boolean; status: number; body: unknown }

const delivered = new Set<string>()

/** Set when the engine refused to register declare_output, as an organization's plugin policy does. */
let isDeclareRefused = false
/** Set when the engine refused to register ask_questions. */
let isAskRefused = false
let companionConfig: CompanionConfig = { companionSocket: '', companionLaunch: '' }
let isStopped = false
let refresh: { cancel: () => void } | undefined
let isUp = false
let backoff = 0
let registeredId: string | undefined
/** Clock ms of the last accepted registration and of the last loop step. */
let registeredAt = 0
let steppedAt = 0
let socket: string | undefined
/** The app's last answer on item tracking, kept for when it stops answering. */
let tracking: (Tracking & { sessionId: string }) | undefined

function initiativeEnvironment($: EngineInterface): InitiativeEnvironment {
  return {
    request: (method, path, body) => call($, method, path, body),
    home: () => homeCwd($),
    isUp,
    ready: async () => {
      if (!(await isHealthy($))) return false
      isUp = true
      await registerSession($)
      return true
    },
    submit: text => submitPrompt($, text),
  }
}

async function socketPath($: EngineInterface): Promise<string> {
  socket ??= socketPathOf(companionConfig.companionSocket, (await $.env.get('HOME')) ?? '')
  return socket
}

/** One request over the socket. Undefined when the app does not answer. */
async function call($: EngineInterface, method: string, path: string, body?: unknown): Promise<Reply | undefined> {
  try {
    const res = await $.http.fetch(`http://companion${path}`, {
      method,
      socketPath: await socketPath($),
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    })
    return { ok: res.ok, status: res.status, body: parseJson(res.text) }
  } catch (err) {
    log($, `companion ${method} ${path} failed: ${String(err)}`)
    return undefined
  }
}

async function isHealthy($: EngineInterface): Promise<boolean> {
  return (await call($, 'GET', '/health'))?.ok === true
}

/** What the app shows for this session: where it runs, what the user last asked, and when it last replied. */
async function sessionExtras($: EngineInterface) {
  const settle = (value: Promise<string | undefined>) => value.catch(() => undefined)
  const env = {
    TERM_PROGRAM: await settle($.env.get('TERM_PROGRAM')),
    __CFBundleIdentifier: await settle($.env.get('__CFBundleIdentifier')),
    HERDR_ENV: await settle($.env.get('HERDR_ENV')),
    HERDR_PANE_ID: await settle($.env.get('HERDR_PANE_ID')),
  }
  const messages = await $.session.messages().catch(() => [])
  const activeAt = (await read($, activeAtRef).catch(() => null)) ?? undefined
  return { host: hostOf(env), summary: summaryOf(Array.isArray(messages) ? messages : []), activeAt }
}

/**
 * The session's project folder, which a cd in the shell does not move.
 * Engines without `session.root` use the folder kept at start. As homeCwd in outputs-file.ts.
 */
async function homeCwd($: EngineInterface): Promise<string> {
  try {
    const root = await $.session.root()
    if (root) return root
  } catch {
    // An older engine has no session.root.
  }
  return (await read($, homeRef)) ?? (await $.session.cwd())
}

async function registerSession($: EngineInterface): Promise<boolean> {
  const sessionId = await $.session.id()
  const isNew = registeredId !== sessionId
  const info = sessionInfo(sessionId, await homeCwd($), await sessionExtras($))
  const reply = await call($, 'POST', '/sessions', info)
  if (!reply?.ok) return false
  registeredId = sessionId
  registeredAt = await $.clock.now()
  if (isNew && (await read($, modeRef)) !== 'default') await mirrorMode($)
  if (isNew) {
    initiativesReadAt = registeredAt
    void loadInitiative($, initiativeEnvironment($)).catch(err => log($, `initiative load failed: ${String(err)}`))
  }
  return true
}

async function ack($: EngineInterface, id: string): Promise<void> {
  await call($, 'POST', `/deliveries/${encodeURIComponent(id)}/ack`)
}

/** Resolves true when the delivery is done, false when it should be tried again. */
async function deliver($: EngineInterface, d: Delivery): Promise<boolean> {
  if (delivered.has(d.id)) {
    await ack($, d.id)
    return true
  }
  if (d.mode === 'submit') {
    delivered.add(d.id)
    try {
      await $.prompt.submit({ text: d.draft, asUser: true })
    } catch (err) {
      delivered.delete(d.id)
      log($, `companion submit failed: ${String(err)}`)
      return false
    }
  } else {
    const box = await $.prompt.read()
    const filled = await $.prompt.fill(fillRequest(box.text, d.draft))
    if (!filled.isFilled) return false
    delivered.add(d.id)
  }
  $.ui.toast(toastFor(d.mode))
  await ack($, d.id)
  return true
}

/** Runs one step of the loop and returns how long to wait before the next. */
async function step($: EngineInterface): Promise<number> {
  steppedAt = await $.clock.now()
  if (!isUp) {
    if (!(await isHealthy($))) {
      backoff = nextBackoff(backoff)
      return backoff
    }
    isUp = true
    backoff = 0
    registeredId = undefined
  }

  const sessionId = await $.session.id()
  if (registeredId !== sessionId) await registerSession($)

  const reply = await call($, 'GET', deliveriesPath(sessionId))
  if (!reply?.ok) {
    isUp = false
    backoff = nextBackoff(backoff)
    return backoff
  }
  for (const d of parseDeliveries(reply.body)) {
    if (!(await deliver($, d))) return FILL_RETRY_MS
  }
  return POLL_GAP_MS
}

function schedule($: EngineInterface, ms: number): void {
  if (isStopped) return
  $.clock.after(ms, () => {
    void tick($)
  })
}

async function tick($: EngineInterface): Promise<void> {
  if (isStopped) return
  let wait = nextBackoff(backoff)
  try {
    wait = await step($)
  } catch (err) {
    log($, `companion loop step failed: ${String(err)}`)
    backoff = nextBackoff(backoff)
    wait = backoff
  }
  schedule($, wait)
}

/**
 * Polls /health for 10 s. The wait is a process, not a clock sleep, because a
 * hook's 10 s budget counts sleeps but not `$` calls in flight.
 */
async function waitForApp($: EngineInterface): Promise<boolean> {
  for (let i = 0; i < LAUNCH_ATTEMPTS; i++) {
    if (await isHealthy($)) return true
    await $.process.run(['sleep', LAUNCH_STEP_S]).catch(() => undefined)
  }
  return false
}

/** Starts the delivery loop and the 60 s re-registration. */
function startCompanion($: EngineInterface, settings: CompanionConfig): void {
  companionConfig = settings
  delivered.clear()
  isStopped = false
  isUp = false
  backoff = 0
  registeredId = undefined
  socket = undefined
  refresh?.cancel()
  refresh = $.clock.every(REREGISTER_MS, () => {
    if (!isStopped && isUp) void registerSession($).catch(() => undefined)
  })
  schedule($, 0)
}

/** Runs after each main-loop turn, so a loop that never started or stopped cannot leave the session unregistered. */
async function keepRegistered($: EngineInterface, settings: CompanionConfig): Promise<void> {
  if (isStopped) return
  const { isLoopStale, isLapsed } = upkeep(await $.clock.now(), steppedAt, registeredAt)
  if (isLoopStale) {
    log($, 'companion loop was idle; starting it again')
    startCompanion($, settings)
    return
  }
  if (isLapsed && isUp) await registerSession($)
}

/** Ends the loop and removes the session from the app. */
async function endCompanion($: EngineInterface, sessionId: string, isFinal: boolean): Promise<void> {
  if (isFinal) {
    isStopped = true
    refresh?.cancel()
  }
  await call($, 'DELETE', sessionPath(sessionId))
  if (!isFinal) registeredId = undefined
}

/**
 * Item tracking for this session. One GET while the app is up.
 * Without an answer it falls back to the last one, so a fresh session with the app down tracks nothing.
 */
async function currentTracking($: EngineInterface): Promise<Tracking | undefined> {
  const sessionId = await $.session.id()
  const cached = tracking?.sessionId === sessionId ? tracking : undefined
  if (!isUp) return cached
  const reply = await call($, 'GET', sessionPath(sessionId))
  if (reply === undefined) return cached
  return setTracking($, sessionId, reply.ok ? reply.body : undefined)
}

/** Keeps the app's answer, and redraws the Brief pane's Track toggle when it changed. */
async function setTracking($: EngineInterface, sessionId: string, body: unknown): Promise<Tracking> {
  tracking = { sessionId, ...trackingOf(body) }
  const isOn = tracking.trackItems
  await update($, trackingRef, () => isOn)
  return tracking
}

/** Answers `/track [on|off]`. Never starts the app. */
async function trackCommand($: EngineInterface, args: string): Promise<string> {
  if (trackTarget(args, false) === undefined) return TRACK_USAGE
  if (!(await isHealthy($))) return TRACK_NOT_RUNNING
  isUp = true
  await registerSession($)
  const sessionId = await $.session.id()
  const isOn = trackTarget(args, (await currentTracking($))?.trackItems ?? false)!
  const body: TrackingPatch = { trackItems: isOn }
  const reply = await call($, 'PATCH', sessionPath(sessionId), body)
  if (reply === undefined) return TRACK_NOT_RUNNING
  if (!reply.ok) return TRACK_UNSUPPORTED
  return trackReply(await setTracking($, sessionId, reply.body), await homeCwd($))
}

/** Tells the app this session's mode. Best effort, and only while the app is up. */
async function mirrorMode($: EngineInterface): Promise<void> {
  if (!isUp) return
  const body = modePatch(await read($, modeRef), await read($, fidelityRef))
  const reply = await call($, 'PATCH', sessionPath(await $.session.id()), body)
  if (reply !== undefined && !reply.ok) log($, `mode mirror answered ${reply.status}`)
}

/** Sets the mode for `/mode` and the band, and returns what to tell the user. */
async function applyMode($: EngineInterface, { mode, fidelity }: ModeChoice): Promise<string> {
  const rung = mode === 'prototype' ? fidelity : null
  const isChanged = (await read($, modeRef)) !== mode || (await read($, fidelityRef)) !== rung
  await update($, modeRef, () => mode)
  await update($, fidelityRef, () => rung)
  void mirrorMode($).catch(err => log($, `mode mirror failed: ${String(err)}`))
  return modeToast(mode, rung, isChanged)
}

/** Answers `/mode [mode] [fidelity]`. */
async function modeCommand($: EngineInterface, args: string): Promise<string> {
  const parsed = parseModeArgs(args)
  if (parsed.kind === 'usage') return MODE_USAGE
  if (parsed.kind === 'report') return modeReport(await read($, modeRef), await read($, fidelityRef))
  return applyMode($, parsed)
}

/** The first folder file found from the cwd up to the home dir. A missing file is normal. */
async function folderMode($: EngineInterface): Promise<ModeChoice | undefined> {
  const home = (await $.env.get('HOME')) ?? ''
  for (const path of modeFilePaths(await homeCwd($), home)) {
    const text = await $.fs.read(path).catch(() => undefined)
    if (typeof text === 'string') return parseModeFile(text)
  }
  return undefined
}

/** A mode the session already holds survives a reload; otherwise the folder default applies. */
async function resolveMode($: EngineInterface): Promise<void> {
  if ((await $.state.get(MODE_STATE)).value === undefined) {
    const found = await folderMode($)
    if (found !== undefined) {
      await update($, modeRef, () => found.mode)
      await update($, fidelityRef, () => found.fidelity)
    }
  }
  await update($, pickingRef, () => 'none')
}

type OpenMode = 'sketch' | 'write'

/** What large pastes in the prompt box held, by placeholder number. Cleared when the box empties. */
const pastes = new Map<number, string>()

type Opened = { message: string; tookText: boolean }

/** Starts the app when needed and registers this session. Undefined once ready, else what to tell the user. */
async function readyApp($: EngineInterface): Promise<string | undefined> {
  if (!(await isHealthy($))) {
    if (companionConfig.companionLaunch.trim() !== '') {
      await $.process.run(['sh', '-c', companionConfig.companionLaunch], { timeoutMs: 5_000 }).catch(() => undefined)
    }
    if (!(await waitForApp($))) return launchFailureText(companionConfig.companionLaunch, await socketPath($))
  }
  isUp = true
  if (!(await registerSession($))) return 'Agent Brief is running but did not accept this session.'
  return undefined
}

/**
 * Answers `/sketch`, `/stack` and `/write`: starts the app when needed, then opens the panel in that mode.
 * `tookText` says the app started the note with `text`; an app before 0.2.3 drops it.
 */
async function openCompanion(
  $: EngineInterface,
  mode: OpenMode,
  { prompt = '', text = '', layout, board }: { prompt?: string; text?: string; layout?: BoardLayout; board?: string } = {},
): Promise<Opened> {
  const fail = (message: string): Opened => ({ message, tookText: false })
  const failed = await readyApp($)
  if (failed !== undefined) return fail(failed)
  const body: OpenRequest = {
    sessionId: await $.session.id(),
    ...(prompt === '' ? {} : { prompt }),
    ...(mode === 'write' ? { mode } : {}),
    ...(mode === 'write' && text !== '' ? { text } : {}),
    ...(layout ? { layout } : {}),
    ...(board ? { board } : {}),
  }
  const opened = await call($, 'POST', '/open', body)
  if (!opened?.ok) return fail('Agent Brief is running but did not open the panel.')
  const tookText = (opened.body as { noteText?: unknown } | undefined)?.noteText === true
  return { message: mode === 'write' ? WRITE_OPENED : layout === 'stack' ? STACK_OPENED : SKETCH_OPENED, tookText }
}

/** `/write last` takes Claude's newest reply; anything else after `/write` starts the note. */
async function writeCommand($: EngineInterface, args: string): Promise<string> {
  if (args.toLowerCase() !== 'last') return (await openCompanion($, 'write', { text: args })).message
  const reply = lastReply(await $.session.messages().catch(() => []))
  if (reply === undefined) return 'Claude has not replied yet in this session.'
  return (await openCompanion($, 'write', { text: reply })).message
}

/**
 * The Write button moves the prompt box's draft, pastes included, into the new note. The box empties only once the note holds it.
 * With the box empty, the note takes Claude's last reply, or starts empty before Claude has replied.
 */
async function writeFromBox($: EngineInterface): Promise<string> {
  const box = await $.prompt.read()
  const text = expandPastes(box.text, pastes).trim()
  if (text === '') {
    const reply = lastReply(await $.session.messages().catch(() => []))
    return (await openCompanion($, 'write', { text: reply ?? '' })).message
  }
  const opened = await openCompanion($, 'write', { text })
  if (opened.tookText) await $.prompt.fill({ text: '', mode: 'replace' }).catch(() => undefined)
  return opened.message
}

/** Where this session's items file lives. */
async function itemsLocation($: EngineInterface): Promise<{ path: string; relPath: string }> {
  const sessionId = await $.session.id()
  return { path: itemsFile(await homeCwd($), sessionId), relPath: itemsRelPath(sessionId) }
}

/** Reads the items file into the state the Brief pane and band draw from. */
async function refreshItems($: EngineInterface): Promise<void> {
  const { path, relPath } = await itemsLocation($)
  const raw = await $.fs.read(path).catch(() => undefined)
  const text = typeof raw === 'string' ? raw : null
  await update($, itemsRef, held => (held?.path === path && held.text === text ? held : { path, relPath, text }))
}

/** Counts each file output's open feedback items, from the `.feedback.md` beside it. */
async function refreshFeedback($: EngineInterface): Promise<void> {
  const cwd = await homeCwd($)
  const counts: Record<string, number> = {}
  for (const o of await read($, outputsRef)) {
    if (/^https?:\/\//i.test(o.ref)) continue
    const text = await $.fs.read(feedbackFileOf(cwd, o.ref)).catch(() => undefined)
    const open = typeof text === 'string' ? openFeedback(text) : 0
    if (open > 0) counts[o.ref] = open
  }
  await update($, feedbackRef, held => (JSON.stringify(held) === JSON.stringify(counts) ? held : counts))
}

/** Reads the outputs file, the items file and the outputs' feedback into the Brief pane's state. */
async function loadBrief($: EngineInterface): Promise<void> {
  const text = await $.fs.read(outputsFile(await homeCwd($), await $.session.id())).catch(() => undefined)
  const file = typeof text === 'string' ? parseOutputsFile(text) : undefined
  await update($, outputsRef, () => file?.outputs ?? [])
  await refreshItems($)
  await refreshFeedback($)
}

/**
 * Whether the Brief pane is placed, kept here so a press can open it without an await first.
 * The `ui.open` and `ui.close` hooks below keep it true to opens made elsewhere, as by ask_questions.
 */
let isBriefOpen = false

/**
 * When the session last asked the app for the initiatives and its attachment, at registration or from the Brief pane.
 * The pane reads them again when it draws after 30 s, and on its first draw after the band opens it or any close.
 */
let initiativesReadAt: number | undefined
const INITIATIVES_FRESH_MS = 30_000

/** Redraws the Brief pane each minute while it is placed, so output ages stay current. */
let briefAging: { cancel(): void } | undefined
const AGING_MS = 60_000

/**
 * The band's Brief button: opens the pane, or closes it while open. Never opens on its own.
 * `$.ui.open` is the first call, with no await before it, so the engine still counts the
 * open as the user's press. An open after an await is unasked and waits for 144 columns.
 */
function toggleBrief($: EngineInterface): Promise<void> {
  if (isBriefOpen) {
    isBriefOpen = false
    initiativesReadAt = undefined
    return $.ui.close({ id: BRIEF_PANE })
  }
  isBriefOpen = true
  const opening = $.ui.open({ id: BRIEF_PANE, title: 'Brief', columns: BRIEF_COLUMNS, rows: BRIEF_ROWS })
  initiativesReadAt = undefined
  return opening.then(async opened => {
    if (!opened.isPlaced) $.ui.toast(`Brief pane not shown: ${opened.reason}`, { timeoutMs: 8000 })
    await loadBrief($).catch(err => log($, `brief load failed: ${String(err)}`))
  })
}

/** Opens an output in its default app, or a URL in the browser. */
async function openOutput($: EngineInterface, ref: string): Promise<void> {
  const target = openTarget(await homeCwd($), ref)
  const ran = await $.process.run(['open', target]).catch((err: unknown) => ({ exitCode: 1, stderr: String(err) }))
  if (ran.exitCode !== 0) $.ui.toast(`Could not open ${ref}: ${ran.stderr.trim() || `open exited ${ran.exitCode}`}`, { timeoutMs: 8000 })
}

/** Opens a Markdown or HTML output in the app, as a note in Write or in the review pane. */
async function openOutputInApp($: EngineInterface, ref: string, tab?: 'feedback'): Promise<void> {
  const failed = await readyApp($)
  if (failed !== undefined) {
    $.ui.toast(failed, { timeoutMs: 8000 })
    return
  }
  const body: OpenRequest = { sessionId: await $.session.id(), output: { path: ref, ...(tab ? { tab } : {}) } }
  const reply = await call($, 'POST', '/open', body)
  if (!reply?.ok) {
    const error = (reply?.body as { error?: unknown } | undefined)?.error
    $.ui.toast(typeof error === 'string' ? error : `Agent Brief did not open ${ref}.`, { timeoutMs: 8000 })
    return
  }
  if (!isOutputOpened(reply.body)) $.ui.toast(OUTPUT_NEEDS_UPDATE, { timeoutMs: 8000 })
}

/** Set while a Send runs, so a second press before it clears the answers submits nothing. */
let isSendingAnswers = false
let isSendingQuestions = false

/**
 * Appends the held answers to the items file as `You:` lines, then submits the decisions message.
 * The file is read fresh, so an item answered elsewhere since keeps that answer and drops the held one.
 */
async function sendAnswers($: EngineInterface): Promise<void> {
  if (isSendingAnswers) return
  isSendingAnswers = true
  try {
    await sendHeldAnswers($)
  } finally {
    isSendingAnswers = false
  }
}

async function sendHeldAnswers($: EngineInterface): Promise<void> {
  const answers = await read($, answersRef)
  if (answers.length === 0) {
    $.ui.toast(NOTHING_HELD)
    return
  }
  const { path, relPath } = await itemsLocation($)
  const text = await $.fs.read(path).catch(() => undefined)
  if (typeof text !== 'string') {
    $.ui.toast(NO_ITEMS_FILE)
    return
  }
  const { decisions, dropped } = heldDecisions(text, answers)
  const written = decisions.length === 0 ? text : withDecisions(text, decisions)
  try {
    if (written !== text) await $.fs.write(path, written)
  } catch (err) {
    $.ui.toast(`Could not write ${relPath}: ${String(err)}`, { timeoutMs: 8000 })
    return
  }
  await update($, itemsRef, () => ({ path, relPath, text: written }))
  await update($, answersRef, () => [])
  if (dropped.length > 0) $.ui.toast(droppedText(dropped), { timeoutMs: 8000 })
  if (decisions.length === 0) return
  const draft = decisionsDraft(relPath, decisions, parseItems(text))
  $.prompt.submit({ text: draft, asUser: true }).catch(err => log($, `answers submit failed: ${String(err)}`))
}

/** Submits the answers to Claude's questions as one message, then clears the Questions section. */
async function sendQuestionAnswers($: EngineInterface): Promise<void> {
  if (isSendingQuestions) return
  isSendingQuestions = true
  try {
    const draft = answersMessage(await read($, questionsRef))
    if (draft === undefined) {
      $.ui.toast(NOTHING_ANSWERED)
      return
    }
    await update($, questionsRef, () => [])
    $.prompt.submit({ text: draft, asUser: true }).catch(err => log($, `question answers submit failed: ${String(err)}`))
  } finally {
    isSendingQuestions = false
  }
}

/** The pane's Mode Select. Prototype waits for its fidelity Select before it applies. */
async function pickBriefMode($: EngineInterface, mode: SessionMode): Promise<void> {
  if (mode === 'prototype') {
    const isPending = (await read($, modeRef)) !== 'prototype'
    await update($, briefRef, view => ({ ...view, isPrototypePending: isPending }))
    return
  }
  await update($, briefRef, view => ({ ...view, isPrototypePending: false }))
  $.ui.toast(await applyMode($, { mode, fidelity: null }), { timeoutMs: 8000 })
}

async function pickBriefFidelity($: EngineInterface, fidelity: PrototypeFidelity): Promise<void> {
  await update($, briefRef, view => ({ ...view, isPrototypePending: false }))
  $.ui.toast(await applyMode($, { mode: 'prototype', fidelity }), { timeoutMs: 8000 })
}

/** The running yap: its pid once printed, and whether Stop came before the pid did. */
let dictation: { pid?: string; isStopWanted: boolean } | undefined

/** The band's Talk button: starts dictation, or stops it while listening. */
async function toggleDictation($: EngineInterface): Promise<void> {
  const voice = await read($, voiceRef)
  if (voice === null && dictation === undefined) {
    dictation = { isStopWanted: false }
    await update($, voiceRef, () => listening())
    // A timer, so the press returns while yap listens.
    $.clock.after(0, () => void runDictation($))
  } else if (voice?.phase === 'listening') {
    await stopDictation($)
  }
}

/** SIGINT makes yap print its transcript and exit. Before the pid arrives, the stop waits for it. */
async function stopDictation($: EngineInterface): Promise<void> {
  if (dictation === undefined) return
  dictation.isStopWanted = true
  await update($, voiceRef, voice => (voice === null ? null : { ...voice, phase: 'finishing' as const }))
  if (dictation.pid !== undefined) {
    await $.process.run(['kill', '-INT', dictation.pid]).catch(err => log($, `dictation stop failed: ${String(err)}`))
  }
}

/** Runs yap until it stops, then puts what it heard in the prompt box. */
async function runDictation($: EngineInterface): Promise<void> {
  const ticking = $.clock.every(1000, () => void update($, voiceRef, addSecond).catch(() => undefined))
  const cap = $.clock.after(DICTATION_MAX_MS, () => void stopDictation($))
  let stdout = ''
  let stderr = ''
  try {
    const child = $.process.spawn({ argv: DICTATE_ARGV })
    for await (const { stream, text } of child) {
      if (stream === 'stderr') {
        stderr += text
        continue
      }
      stdout += text
      const { pid } = splitDictation(stdout)
      if (dictation !== undefined && dictation.pid === undefined && pid !== undefined) {
        dictation.pid = pid
        if (dictation.isStopWanted) await stopDictation($)
      }
    }
    const ended = await child.result
    const { text } = splitDictation(stdout)
    if (ended.code === YAP_MISSING) $.ui.toast(YAP_MISSING_TEXT, { timeoutMs: 8000 })
    else if (text !== '') await fillDictation($, text)
    else if (ended.code !== 0 && ended.signal === null && stderr.trim() !== '') $.ui.toast(failureText(stderr, ended.code), { timeoutMs: 8000 })
    else $.ui.toast(DICTATION_EMPTY)
  } catch (err) {
    log($, `dictation failed: ${String(err)}`)
    $.ui.toast(failureText(String(err), null), { timeoutMs: 8000 })
  } finally {
    ticking.cancel()
    cap.cancel()
    dictation = undefined
    await update($, voiceRef, () => null).catch(() => undefined)
  }
}

/** Puts the words in at the cursor. The words in the box say it worked; a box that refuses keeps them on the clipboard. */
async function fillDictation($: EngineInterface, text: string): Promise<void> {
  const box = await $.prompt.read()
  const filled = await $.prompt.fill(dictationFill(box, text))
  if (filled.isFilled) return
  await $.ui.copy({ text }).catch(() => undefined)
  $.ui.toast(DICTATION_NO_BOX, { timeoutMs: 8000 })
}

// One ingest run at a time per module instance.
let isIngesting = false

function log($: EngineInterface, text: string): void {
  $.ui.log(`agent-brief: ${text}`, { to: 'debug' })
}

async function save($: EngineInterface, sessions: FeedbackInboxSession[]): Promise<void> {
  await update($, sessionsRef, () => sessions)
  await $.store.set(`sessions:${await homeCwd($)}`, sessions)
}

async function inboxDir($: EngineInterface, config: Config): Promise<string> {
  const home = (await $.env.get('HOME')) ?? ''
  return expandHome(config.inboxDir || '~/Downloads/feedback-inbox', home)
}

/** Store entries whose report still exists, plus `.feedback/*` folders not yet known. */
async function load($: EngineInterface): Promise<FeedbackInboxSession[]> {
  const cwd = await homeCwd($)
  const stored = await $.store.get(`sessions:${cwd}`)
  let sessions: FeedbackInboxSession[] = []
  for (const s of Array.isArray(stored) ? (stored as FeedbackInboxSession[]) : []) {
    if (await $.fs.stat(s.reportPath).then(() => true, () => false)) sessions.push(s)
  }
  const root = `${cwd}/.feedback`
  const entries = await $.fs.list(root).catch(() => [])
  for (const entry of entries) {
    if (entry.kind !== 'dir' || sessions.some(s => s.name === entry.name)) continue
    const dir = `${root}/${entry.name}`
    const reportPath = `${dir}/report.md`
    const stat = await $.fs.stat(reportPath).catch(() => undefined)
    if (!stat) continue
    const shots = await $.fs.list(`${dir}/screenshots`).catch(() => [])
    const counts = await $.fs
      .read(`${dir}/session.json`)
      .then(text => countEvents(JSON.parse(String(text))))
      .catch(() => null)
    sessions = upsert(sessions, {
      name: entry.name,
      dir,
      reportPath,
      screenshots: shots.filter(s => s.kind === 'file').map(s => `${dir}/screenshots/${s.name}`).sort(),
      counts,
      ingestedAt: stat.mtimeMs,
      isConsumed: false,
    })
  }
  return sessions
}

/** Zips waiting in the inbox, oldest first. */
async function waitingZips($: EngineInterface, config: Config): Promise<string[]> {
  const entries = await $.fs.list(await inboxDir($, config)).catch(() => [])
  return entries
    .filter(e => e.kind === 'file' && e.name.endsWith('.zip'))
    .sort((a, b) => a.mtimeMs - b.mtimeMs)
    .map(e => e.name)
}

/** Ingests every waiting zip into this project. Runs only when the user asks. */
async function ingestAll($: EngineInterface, config: Config): Promise<void> {
  if (isIngesting) return
  isIngesting = true
  try {
    const inbox = await inboxDir($, config)
    for (const zip of await waitingZips($, config)) await ingestOne($, config, inbox, zip)
  } catch (err) {
    log($, `ingest failed: ${String(err)}`)
  } finally {
    isIngesting = false
  }
}

/** Claims and ingests one zip; false when another session took it first. */
async function ingestOne($: EngineInterface, config: Config, inbox: string, file: string): Promise<boolean> {
  await $.process.run(['mkdir', '-p', `${inbox}/processing`, `${inbox}/done`, `${inbox}/failed`])
  const claimed = `${inbox}/processing/${file}`
  const claim = await $.process.run(['mv', `${inbox}/${file}`, claimed])
  if (claim.exitCode !== 0) {
    log($, `skipped ${file}: another session claimed it`)
    return false
  }

  const label = file.replace(/\.zip$/, '')
  await update($, ingestingRef, () => label)
  try {
    const argv = [
      config.nodePath,
      `${$.plugin.root}/bin/ingest.mjs`,
      claimed,
      '--project',
      await homeCwd($),
      '--transcriber',
      config.transcriber,
      ...(config.whisperModel ? ['--whisper-model', config.whisperModel] : []),
    ]
    const outcome = await $.process
      .run(argv, { timeoutMs: INGEST_TIMEOUT_MS })
      .then(r => parseIngestOutput(r.stdout, r.stderr, r.exitCode))
      .catch((err: unknown) => ({ ok: false as const, error: String(err) }))

    if (!outcome.ok) {
      await $.process.run(['mv', claimed, `${inbox}/failed/${file}`])
      $.ui.toast(`Feedback ingest failed (${label}): ${outcome.error}`, { timeoutMs: 8000 })
      log($, `ingest failed for ${file}: ${outcome.error}`)
      return true
    }

    await $.process.run(['mv', claimed, `${inbox}/done/${file}`])
    const sessions = upsert(await read($, sessionsRef), {
      name: outcome.name,
      dir: outcome.dir,
      reportPath: outcome.reportPath,
      screenshots: outcome.screenshots,
      counts: outcome.counts,
      ingestedAt: await $.clock.now(),
      isConsumed: false,
    })
    await save($, sessions)
    return true
  } finally {
    await update($, ingestingRef, () => null)
  }
}

function submitPrompt($: EngineInterface, text: string): void {
  $.prompt.submit({ text }).catch(err => log($, `submit failed: ${String(err)}`))
}

/** Picks a session and submits the prompt that applies it. Undefined when none matches. */
async function apply($: EngineInterface, name: string | undefined): Promise<FeedbackInboxSession | undefined> {
  const sessions = await load($)
  const session = pickSession(sessions, name)
  if (!session) return undefined
  await save($, markConsumed(sessions, session.name))
  submitPrompt($, feedbackPrompt(session.name))
  return session
}

/** A note for Claude when recordings wait in the inbox, else ''. */
async function inboxNote($: EngineInterface, config: Config): Promise<string> {
  const n = (await waitingZips($, config)).length
  if (n === 0) return ''
  return `\n${n === 1 ? '1 recording waits' : `${n} recordings wait`} in the inbox. Ask the user to run /apply-feedback in the project it belongs to.`
}

/** The terminal and tmux facts the picture hooks need. A tmux with passthrough off is known before the first picture. */
async function showEnvironment($: EngineInterface, cwd: string, nodePath: string): Promise<ShowEnvironment> {
  const missing = () => undefined
  const term = (await $.env.get('TERM').catch(missing)) ?? ''
  const isTmux = !!(await $.env.get('TMUX').catch(missing)) || /^tmux/i.test(term)
  let isPassthroughOff = false
  if (isTmux) {
    const pass = await $.process.run(['tmux', 'show', '-gv', 'allow-passthrough']).catch(() => undefined)
    isPassthroughOff = pass !== undefined && pass.exitCode === 0 && /^off$/i.test(pass.stdout.trim())
  }
  return {
    cwd,
    home: (await $.env.get('HOME').catch(missing)) ?? '',
    sessionId: await $.session.id().catch(() => ''),
    program: (await $.env.get('TERM_PROGRAM').catch(missing)) ?? '',
    term,
    isTmux,
    isPassthroughOff,
    isHerdr: (await $.env.get('HERDR_ENV').catch(missing)) === '1',
    nodePath,
  }
}

const noSession = (name: string | undefined) =>
  name ? `No feedback session named "${name}".` : 'No feedback sessions in .feedback/ or the inbox yet.'

export const register: Register = (on, options) => {
  const companionSettings: CompanionConfig = {
    companionSocket: String(options.companionSocket ?? ''),
    companionLaunch: String(options.companionLaunch ?? 'open -a "Agent Brief"'),
  }
  const config: Config = {
    inboxDir: String(options.inboxDir ?? ''),
    nodePath: String(options.nodePath || 'node'),
    transcriber: String(options.transcriber || 'yap'),
    whisperModel: String(options.whisperModel ?? ''),
  }

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // A reload fires this again from wherever the shell has moved, so only the first one sets home.
    if ((await read($, homeRef)) === null) {
      const cwd = await homeCwd($)
      await update($, homeRef, () => cwd).catch(() => undefined)
    }
    // A reload ends yap with the old module, so a kept listening state is stale.
    if (dictation === undefined) await update($, voiceRef, () => null).catch(() => undefined)
    // A resumed session already has prompts, so the band starts without its Mode button and no recent line goes out.
    try {
      const messages = await $.session.messages().catch(() => [])
      if (Array.isArray(messages) && hasUserPrompt(messages)) {
        await update($, hasPromptedRef, () => true)
        await markInitiativeResumed($)
      }
      await loadBrief($)
    } catch (err) {
      log($, `brief start failed: ${String(err)}`)
    }
    try {
      const sessions = await load($)
      await update($, sessionsRef, () => sessions)
      await $.tool.register({
        name: 'feedback_latest',
        description:
          'Returns the newest recorded browser feedback session for this project (report.md text plus screenshot paths) and marks it applied. ' +
          'Call it when the user says "apply my feedback" or asks about their recorded feedback. Pass `name` to pick a session from feedback_list.',
        inputSchema: {
          type: 'object',
          properties: { name: { type: 'string', description: 'Session folder name under .feedback/' } },
        },
        isDeferred: false,
      })
      await $.tool.register({
        name: 'feedback_list',
        description: 'Lists recorded browser feedback sessions in .feedback/, newest first, with whether each was applied.',
        inputSchema: { type: 'object', properties: {} },
        isDeferred: false,
      })
    } catch (err) {
      log($, `feedback start failed: ${String(err)}`)
    }
    // Commands register apart from tools, so a policy that refuses the plugin's tools leaves them working.
    try {
      await $.command.register({
        name: 'apply-feedback',
        description: 'Apply recorded browser feedback (newest unapplied, or the named session)',
        argumentHint: '[name]',
      })
    } catch (err) {
      log($, `apply-feedback refused: ${String(err)}`)
    }
    try {
      await $.command.register({
        name: 'sketch',
        description: 'Open the Agent Brief sketch board for this session',
        argumentHint: '[what to draw or ask]',
      })
      await $.command.register({
        name: 'stack',
        description: "Open this session's Agent Brief board in Stack: each drop or paste of screenshots becomes a numbered group",
        argumentHint: '[what to capture or ask]',
      })
      await $.command.register({
        name: 'write',
        description: 'Open a new Agent Brief note for this session: with text, or Claude\'s last reply',
        argumentHint: '[text | last]',
      })
      await $.command.register({
        name: 'track',
        description: "Track this session's items in the Agent Brief panel",
        argumentHint: '[on|off]',
      })
      await resolveMode($).catch(err => log($, `mode resolution failed: ${String(err)}`))
      await $.command.register({
        name: 'mode',
        description: "Set this session's mode: default, product, prototype <fidelity>, orchestrate.",
        argumentHint: '[default | product | prototype <fidelity> | orchestrate]',
      })
    } catch (err) {
      log($, `command registration failed: ${String(err)}`)
    }
    // Apart from the commands, so a refused command never leaves the session unregistered.
    try {
      startCompanion($, companionSettings)
    } catch (err) {
      log($, `companion start failed: ${String(err)}`)
    }
    try {
      await $.tool.register({
        name: 'declare_output',
        description:
          'Names a deliverable the user asked for (a doc, brief, report, spec, page, deck or artifact) so it shows in the Agent Brief panel. ' +
          'Call it with status drafting when you start the deliverable and again with ready when it is done. ' +
          'Pass path for a file relative to the project, or url for an artifact or published page, never both. ' +
          'Never declare code, config, tests or other files that serve the code.',
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'What the user would call it, such as "Pricing strategy"' },
            path: { type: 'string', description: 'The file, relative to the project' },
            url: { type: 'string', description: 'An http or https link to an artifact or published page' },
            status: { type: 'string', enum: ['drafting', 'ready'], default: 'drafting' },
          },
          required: ['title'],
        },
        isDeferred: false,
      })
      isDeclareRefused = false
    } catch (err) {
      isDeclareRefused = true
      log($, `declare_output refused: ${String(err)}`)
    }
    try {
      await $.tool.register(ASK_TOOL_SPEC)
      isAskRefused = false
    } catch (err) {
      isAskRefused = true
      log($, `ask_questions refused: ${String(err)}`)
    }
    try {
      await $.command.register({
        name: 'outputs',
        description: "List this session's outputs: declared deliverables, then touched documents",
      })
    } catch (err) {
      log($, `outputs start failed: ${String(err)}`)
    }
    try {
      await $.command.register(GRILL_COMMAND_SPEC)
    } catch (err) {
      log($, `grill refused: ${String(err)}`)
    }
    try {
      await $.command.register(INITIATIVE_COMMAND_SPEC)
    } catch (err) {
      log($, `initiative refused: ${String(err)}`)
    }
    try {
      startShow(await showEnvironment($, started.cwd, config.nodePath))
      await $.command.register(SHOW_COMMAND_SPEC)
    } catch (err) {
      log($, `show start failed: ${String(err)}`)
    }
    try {
      await $.tool.register(SHOW_TOOL_SPEC)
      noteShowToolRefused(false)
    } catch (err) {
      noteShowToolRefused(true)
      log($, `show_image refused: ${String(err)}`)
    }
    return started
  })

  on('tool.call', { tool: 'mcp__agent-brief__feedback_latest' }, async ($, e) => {
    const input = e as { name?: unknown }
    const name = typeof input.name === 'string' && input.name ? input.name : undefined
    const sessions = await load($)
    const session = pickSession(sessions, name)
    if (!session) {
      const text = name ? `No feedback session named "${name}".\n${listText(sessions)}` : listText(sessions)
      return { result: text + (await inboxNote($, config)) }
    }
    const report = await $.fs.read(session.reportPath).catch(() => undefined)
    if (typeof report !== 'string') return { result: `Could not read ${session.reportPath}.` }
    await save($, markConsumed(sessions, session.name))
    return { result: latestText(session, report) }
  }).catch(() => ({ result: 'The feedback inbox failed to read the session. Read .feedback/<name>/report.md directly.' }))

  on('tool.call', { tool: 'mcp__agent-brief__feedback_list' }, async $ => {
    const sessions = await load($)
    await update($, sessionsRef, () => sessions)
    return { result: listText(sessions) + (await inboxNote($, config)) }
  }).catch(() => ({ result: 'The feedback inbox failed to list sessions. List .feedback/ directly.' }))

  // Recordings stay in the inbox until /apply-feedback runs, so they land in the project it runs in.
  on('command.run', { command: 'apply-feedback' }, async ($, e) => {
    const name = e.args.trim() || undefined
    const zips = await waitingZips($, config)
    if (zips.length > 0) {
      // A command.run hook cannot submit; a timer runs after the hook returns.
      $.clock.after(0, async () => {
        await ingestAll($, config)
        if (!(await apply($, name))) $.ui.toast(noSession(name))
      })
      return { text: `Transcribing ${zips.length === 1 ? '1 recording' : `${zips.length} recordings`} from the inbox…` }
    }
    const session = pickSession(await load($), name)
    if (!session) return { text: noSession(name) }
    $.clock.after(0, () => void apply($, session.name))
    return { text: `Applying feedback: ${session.name}` }
  })

  // A one-row band with Sketch, Stack, Write, Talk, Mode and Brief buttons: a click, or ctrl+x tab then Enter, does what /sketch, /stack, /write or /mode does.
  // Write takes the prompt box's draft, or Claude's last reply when the box is empty.
  // Talk dictates into the prompt box until pressed again. Mode shows until the first prompt.
  // Brief opens and closes the Brief pane. An attached initiative adds `Attached <title> · change`, and none adds `attach initiative`.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const mode = await read($, modeRef)
    const { initiative, choices } = await initiativeView($)
    const counts = briefCounts(await read($, outputsRef), (await read($, itemsRef))?.text ?? null, (await read($, questionsRef)).length)
    const view: BandView = {
      ingesting: await read($, ingestingRef),
      hasPrompted: await read($, hasPromptedRef),
      briefLabel: briefBandLabel(counts, mode),
      mode,
      fidelity: await read($, fidelityRef),
      picking: await read($, pickingRef),
      voice: await read($, voiceRef),
      initiative,
      choices,
      ...(e.surface === 'terminal' && needsProbe() ? { probe: { key: PROBE_KEY, png: CLEAR_PIXEL } } : {}),
    }
    if (view.probe && !isBandProbing) {
      // The pixel mounts with this frame, so its blit waits a beat.
      isBandProbing = true
      $.clock.after(250, async () => {
        try {
          const r = await $.ui.blit({ requestId: e.requestId, key: PROBE_KEY, source: { png: CLEAR_PIXEL } })
          log($, `band picture probe: ${r.deny ?? 'drew'}`)
          if (noteProbe(r.deny)) {
            $.ui.invalidate('prompt.section')
            $.ui.invalidate('ui.render')
          }
        } finally {
          isBandProbing = false
        }
      })
    }
    const pick = async (row: BandRow) => {
      await update($, pickingRef, () => row)
      if (row === 'initiative') await loadRecent($, initiativeEnvironment($)).catch(err => log($, `recent initiatives failed: ${String(err)}`))
    }
    return bandTree($.ui.resolve(e), view, {
      open: async target => {
        const result =
          target === 'write'
            ? await writeFromBox($)
            : (await openCompanion($, 'sketch', target === 'stack' ? { layout: 'stack' } : {})).message
        if (result !== SKETCH_OPENED && result !== STACK_OPENED && result !== WRITE_OPENED) $.ui.toast(result, { timeoutMs: 8000 })
      },
      brief: () => toggleBrief($),
      talk: () => toggleDictation($),
      pick,
      choose: async choice => {
        await pick('none')
        $.ui.toast(await applyMode($, choice), { timeoutMs: 8000 })
      },
      attach: id => attachFromBand($, initiativeEnvironment($), id),
      detach: () => detachFromBand($, initiativeEnvironment($)),
    })
  })

  // The Brief pane beside the transcript: outputs, Claude's questions, items and the session's mode.
  on('ui.render', { component: 'Pane', requestId: BRIEF_PANE }, async ($, e) => {
    const props = e.props as { placement: 'dock' | 'inline' }
    const questions = await read($, questionsRef)
    const table = $.ui.resolve(e)
    const hasFields = e.surface !== 'mobile'
    const now = await $.clock.now()
    if (initiativesReadAt === undefined || now - initiativesReadAt > INITIATIVES_FRESH_MS) {
      initiativesReadAt = now
      $.clock.after(0, () => loadInitiative($, initiativeEnvironment($)).catch(err => log($, `initiative load failed: ${String(err)}`)))
    }
    const { initiative, listed, refusals } = await initiativeView($)
    const pane: BriefPaneView = {
      placement: props.placement,
      hasFields,
      project: projectName(await homeCwd($)),
      mode: await read($, modeRef),
      fidelity: await read($, fidelityRef),
      isTracking: await read($, trackingRef),
      outputs: await read($, outputsRef),
      now,
      feedback: await read($, feedbackRef),
      items: await read($, itemsRef),
      answers: await read($, answersRef),
      asked: questions.length,
      view: await read($, briefRef),
      initiative,
      initiatives: listed,
      refusals,
    }
    const asked = questionsTree(table, questions, hasFields, {
      answer: (id, text) => update($, questionsRef, list => answerQuestion(list, id, text)).then(() => undefined),
      other: id => update($, questionsRef, list => openOther(list, id)).then(() => undefined),
      type: (id, text) => update($, questionsRef, list => typeOther(list, id, text)).then(() => undefined),
      clear: id => update($, questionsRef, list => answerQuestion(list, id, '')).then(() => undefined),
      send: () => sendQuestionAnswers($),
    })
    return briefTree(table, pane, {
      open: ref => openOutput($, ref),
      openInApp: (ref, tab) => openOutputInApp($, ref, tab),
      pickMode: mode => pickBriefMode($, mode),
      pickFidelity: fidelity => pickBriefFidelity($, fidelity),
      attach: id => attachFromBand($, initiativeEnvironment($), id),
      detach: () => detachFromBand($, initiativeEnvironment($)),
      track: () => trackCommand($, '').then(text => $.ui.toast(text, { timeoutMs: 8000 })),
      hold: (n, text) => update($, answersRef, list => holdAnswer(list, n, text)).then(() => undefined),
      clear: n => update($, answersRef, list => dropAnswer(list, n)).then(() => undefined),
      send: () => sendAnswers($),
      fold: section => {
        const field = ({ touched: 'isTouchedOpen', done: 'isDoneOpen', expanded: 'isExpanded' } as const)[section]
        return update($, briefRef, view => ({ ...view, [field]: !view[field] })).then(() => undefined)
      },
    }, { questions: asked })
  })

  // The first prompt takes the Mode button off the band.
  // A typed prompt carries the attached initiative's snapshot after the user's text whenever its token moved.
  // While none is attached, the first typed prompt after the recent initiatives load names them, once per session.
  // Never the system prompt.
  on('prompt.submit', async ($, e, next) => {
    let appended: Appended = { context: [] }
    if (e.isMeta === undefined && e.command === undefined) {
      appended = await initiativeContext($, initiativeEnvironment($)).catch((err: unknown) => {
        log($, `initiative context failed: ${String(err)}`)
        return { context: [] }
      })
    }
    const entered = await next(appended.context.length === 0 ? e : { ...e, context: [...(e.context ?? []), ...appended.context] })
    if (!('drop' in entered)) {
      await update($, hasPromptedRef, () => true).catch(() => undefined)
      // The Mode picker leaves the band with the Mode button.
      await update($, pickingRef, () => 'none').catch(() => undefined)
      await recordInitiativePrompt($, appended).catch(() => undefined)
    }
    return entered
  }).catch(($, e, next) => next(e))

  // A compaction drops the snapshot from the conversation, so the next prompt carries it again.
  // A precompute only prepares a summary and leaves the conversation as it is.
  // Where an organization manages Claude Code this event passes over the mod, so there `/initiative refresh` resends it.
  on('session.compact', async ($, e, next) => {
    const compacted = await next(e)
    if (e.agentId === undefined && e.trigger !== 'precompute' && compacted.skip === undefined) await invalidateInitiative($).catch(() => undefined)
    return compacted
  }).catch(($, e, next) => next(e))

  // An `agent-brief initiative` verb Claude ran may attach or detach the session, so the band reads the attachment again.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const result = await next(e)
    if (isInitiativeCommand(e.command)) await fetchInitiative($, initiativeEnvironment($)).catch(err => log($, `initiative refresh failed: ${String(err)}`))
    return result
  }).catch(($, e, next) => next(e))

  // A write to the items file redraws the Brief pane and the band's count.
  on('tool.call', { tool: ['Edit', 'Write'] }, async ($, e, next) => {
    const result = await next(e)
    const sessionId = await $.session.id().catch(() => undefined)
    if (sessionId !== undefined && typeof e.file_path === 'string' && e.file_path.endsWith(`/${itemsRelPath(sessionId)}`)) {
      await refreshItems($).catch(err => log($, `items refresh failed: ${String(err)}`))
    }
    return result
  }).catch(($, e, next) => next(e))

  // Each finished main-loop reply is kept, so its last block can carry the row below.
  // The items file is read again, since the app's panel appends answers to it too.
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined && e.reason === 'answer') await update($, repliesRef, list => keepReply(list, e.answer)).catch(() => undefined)
    if (e.agentId === undefined) {
      const at = await $.clock.now()
      await update($, activeAtRef, () => at).catch(() => undefined)
      await keepRegistered($, companionSettings).catch(() => undefined)
    }
    if (e.agentId === undefined) await refreshItems($).catch(() => undefined)
    // Claude catalogs feedback through the CLI, so its counts are read once the turn ends.
    if (e.agentId === undefined) await refreshFeedback($).catch(() => undefined)
    return done
  })

  // Under the last block of a finished reply: Copy, and Open in Agent Brief as /write last does.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const drawn = await next(e)
    const props = e.props as { text: string; isSummary?: true }
    if (props.isSummary) return drawn
    const reply = replyEndingWith(await read($, repliesRef), props.text)
    if (reply === undefined) return drawn
    const { Box, Button, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {drawn}
        <Box>
          <Button
            key="reply-copy"
            plain
            dimColor
            label="Copy"
            onPress={press =>
              void $.ui.copy({ text: reply, surface: press.surface }).then(r => $.ui.toast(r.isCopied ? 'Reply copied' : 'Could not copy the reply'))
            }
          />
          <Text dimColor> · </Text>
          <Button
            key="reply-open"
            plain
            dimColor
            label="Open in Agent Brief"
            onPress={() =>
              void openCompanion($, 'write', { text: reply }).then(opened => {
                if (opened.message !== WRITE_OPENED) $.ui.toast(opened.message, { timeoutMs: 8000 })
              })
            }
          />
        </Box>
      </Box>
    )
  })

  on('session.end', async ($, e, next) => {
    // After a clear or a resume the process goes on under another id, so the loop keeps running.
    await endCompanion($, e.sessionId, e.reason !== 'clear' && e.reason !== 'resume').catch(() => undefined)
    return next(e)
  })

  on('command.run', { command: 'sketch' }, async ($, e) => ({ text: (await openCompanion($, 'sketch', { prompt: e.args.trim() })).message }))
  on('command.run', { command: 'stack' }, async ($, e) => ({ text: (await openCompanion($, 'sketch', { prompt: e.args.trim(), layout: 'stack' })).message }))
  on('command.run', { command: 'write' }, async ($, e) => ({ text: await writeCommand($, e.args.trim()) }))
  on('command.run', { command: 'track' }, async ($, e) => ({ text: await trackCommand($, e.args) }))
  on('command.run', { command: 'mode' }, async ($, e) => ({ text: await modeCommand($, e.args) }))
  on('command.run', { command: 'initiative' }, async ($, e) => initiativeCommand($, initiativeEnvironment($), e.args))

  // With item tracking on, the system prompt tells Claude to keep the items file.
  // Outside default mode, it also carries the mode's posture.
  // The outputs section is always on. With /grill on, Claude interviews the user before it starts.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const added: { id: string; scope: 'session'; text: string }[] = []
    try {
      const state = await currentTracking($)
      if (state?.trackItems === true && state.itemsPath !== undefined) {
        added.push({ id: ITEMS_SECTION, scope: 'session', text: itemsInstructions(state.itemsPath) })
      }
    } catch (err) {
      log($, `items section failed: ${String(err)}`)
    }
    try {
      const text = sectionText(await read($, modeRef), await read($, fidelityRef))
      if (text !== null) added.push({ id: MODE_SECTION, scope: 'session', text })
    } catch (err) {
      log($, `mode section failed: ${String(err)}`)
    }
    try {
      const isCli = isDeclareRefused && !e.tools.includes(DECLARE_TOOL)
      added.push({ id: OUTPUTS_SECTION, scope: 'session', text: outputsInstructions(isCli) })
    } catch (err) {
      log($, `outputs section failed: ${String(err)}`)
    }
    try {
      if (await read($, grillingRef)) {
        const hasTool = !isAskRefused || e.tools.includes(ASK_TOOL)
        added.push({ id: GRILL_SECTION, scope: 'session', text: grillInstructions(hasTool) })
      }
    } catch (err) {
      log($, `grill section failed: ${String(err)}`)
    }
    const show = showSection(e.tools)
    if (show !== null) added.push(show)
    return added.length === 0 ? composed : { sections: [...composed.sections, ...added] }
  })

  // The mode guard wraps the outputs recorder, so a denied edit is never recorded.
  registerModeGuard(on)
  registerOutputs(on)
  registerQuestions(on)

  // Pictures in the transcript. Their Open board button starts the app when needed, as /sketch does.
  registerShow(on)
  // A placed open from any module, and a close by the person, keep the band's toggle right.
  on('ui.open', { id: BRIEF_PANE }, async ($, e, next) => {
    const opened = await next(e)
    if (opened.deny === undefined && opened.value.isPlaced) {
      isBriefOpen = true
      briefAging ??= $.clock.every(AGING_MS, () => $.ui.invalidate('ui.render'))
    }
    return opened
  })
  on('ui.close', { id: BRIEF_PANE }, ($, e, next) => {
    isBriefOpen = false
    initiativesReadAt = undefined
    briefAging?.cancel()
    briefAging = undefined
    return next(e)
  })

  on('ui.press', async ($, e, next) => {
    const board = boardOfKey(e.element)
    if (board === undefined) return next(e)
    const result = (await openCompanion($, 'sketch', { board })).message
    if (result !== SKETCH_OPENED) $.ui.toast(result, { timeoutMs: 8000 })
    return next(e)
  })

  // Large pastes show as placeholders in the box; keep what each held so Write can carry it.
  on('prompt.edit', async ($, e, next) => {
    const box = await next(e)
    if (box.text === '') pastes.clear()
    else rememberPaste(pastes, e.text, box.text, e.inputText)
    return box
  })
}
