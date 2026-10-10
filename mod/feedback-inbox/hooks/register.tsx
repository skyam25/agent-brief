import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { FeedbackInboxSession } from '../types'
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
  LAUNCH_ATTEMPTS,
  LAUNCH_STEP_S,
  POLL_GAP_MS,
  REREGISTER_MS,
  SKETCH_OPENED,
  deliveriesPath,
  fillRequest,
  launchFailureText,
  nextBackoff,
  parseDeliveries,
  parseJson,
  hostOf,
  sessionInfo,
  socketPathOf,
  summaryOf,
  toastFor,
} from './companion-logic'
import type { Delivery, OpenRequest } from './companion-protocol'

type Config = {
  inboxDir: string
  nodePath: string
  transcriber: string
  whisperModel: string
}

const sessionsRef = atom({ plugin: 'feedback-inbox', key: 'sessions' } as const, [])
const ingestingRef = atom({ plugin: 'feedback-inbox', key: 'ingesting' } as const, null)

const INGEST_TIMEOUT_MS = 10 * 60_000

type CompanionConfig = {
  companionSocket: string
  companionLaunch: string
}

type Reply = { ok: boolean; status: number; body: unknown }

const delivered = new Set<string>()
let companionConfig: CompanionConfig = { companionSocket: '', companionLaunch: '' }
let isStopped = false
let refresh: { cancel: () => void } | undefined
let isUp = false
let backoff = 0
let registeredId: string | undefined
let socket: string | undefined

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

/** What the app shows for this session: where it runs and what the user last asked. */
async function sessionExtras($: EngineInterface) {
  const read = (value: Promise<string | undefined>) => value.catch(() => undefined)
  const env = {
    TERM_PROGRAM: await read($.env.get('TERM_PROGRAM')),
    __CFBundleIdentifier: await read($.env.get('__CFBundleIdentifier')),
    HERDR_ENV: await read($.env.get('HERDR_ENV')),
    HERDR_PANE_ID: await read($.env.get('HERDR_PANE_ID')),
  }
  const messages = await $.session.messages().catch(() => [])
  return { host: hostOf(env), summary: summaryOf(Array.isArray(messages) ? messages : []) }
}

async function registerSession($: EngineInterface): Promise<boolean> {
  const sessionId = await $.session.id()
  const info = sessionInfo(sessionId, await $.session.cwd(), await sessionExtras($))
  const reply = await call($, 'POST', '/sessions', info)
  if (reply?.ok) registeredId = sessionId
  return reply?.ok === true
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

/** Ends the loop and removes the session from the app. */
async function endCompanion($: EngineInterface, sessionId: string, isFinal: boolean): Promise<void> {
  if (isFinal) {
    isStopped = true
    refresh?.cancel()
  }
  await call($, 'DELETE', `/sessions/${encodeURIComponent(sessionId)}`)
  if (!isFinal) registeredId = undefined
}

/** Answers `/sketch`: starts the app when needed, then opens the panel. */
async function sketchCompanion($: EngineInterface, prompt: string): Promise<string> {
  if (!(await isHealthy($))) {
    if (companionConfig.companionLaunch.trim() !== '') {
      await $.process.run(['sh', '-c', companionConfig.companionLaunch], { timeoutMs: 5_000 }).catch(() => undefined)
    }
    if (!(await waitForApp($))) return launchFailureText(companionConfig.companionLaunch, await socketPath($))
  }
  isUp = true
  if (!(await registerSession($))) return 'The companion is running but did not accept this session.'
  const body: OpenRequest = { sessionId: await $.session.id(), ...(prompt === '' ? {} : { prompt }) }
  const opened = await call($, 'POST', '/open', body)
  if (!opened?.ok) return 'The companion is running but did not open the panel.'
  return SKETCH_OPENED
}

// One ingest run at a time per module instance.
let isIngesting = false

function log($: EngineInterface, text: string): void {
  $.ui.log(`feedback-inbox: ${text}`, { to: 'debug' })
}

async function save($: EngineInterface, sessions: FeedbackInboxSession[]): Promise<void> {
  await update($, sessionsRef, () => sessions)
  await $.store.set(`sessions:${await $.session.cwd()}`, sessions)
}

async function inboxDir($: EngineInterface, config: Config): Promise<string> {
  const home = (await $.env.get('HOME')) ?? ''
  return expandHome(config.inboxDir || '~/Downloads/feedback-inbox', home)
}

/** Store entries whose report still exists, plus `.feedback/*` folders not yet known. */
async function load($: EngineInterface): Promise<FeedbackInboxSession[]> {
  const cwd = await $.session.cwd()
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
      await $.session.cwd(),
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

const noSession = (name: string | undefined) =>
  name ? `No feedback session named "${name}".` : 'No feedback sessions in .feedback/ or the inbox yet.'

export const register: Register = (on, options) => {
  const companionSettings: CompanionConfig = {
    companionSocket: String(options.companionSocket ?? ''),
    companionLaunch: String(options.companionLaunch ?? 'open -a "Web Agent Companion"'),
  }
  const config: Config = {
    inboxDir: String(options.inboxDir ?? ''),
    nodePath: String(options.nodePath || 'node'),
    transcriber: String(options.transcriber || 'yap'),
    whisperModel: String(options.whisperModel ?? ''),
  }

  on('session.start', async ($, e, next) => {
    const started = await next(e)
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
      await $.command.register({
        name: 'apply-feedback',
        description: 'Apply recorded browser feedback (newest unapplied, or the named session)',
        argumentHint: '[name]',
      })
    } catch (err) {
      log($, `start failed: ${String(err)}`)
    }
    try {
      await $.command.register({
        name: 'sketch',
        description: 'Open the companion sketch board for this session',
        argumentHint: '[what to draw or ask]',
      })
      startCompanion($, companionSettings)
    } catch (err) {
      log($, `companion start failed: ${String(err)}`)
    }
    return started
  })

  on('tool.call', { tool: 'mcp__feedback-inbox__feedback_latest' }, async ($, e) => {
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

  on('tool.call', { tool: 'mcp__feedback-inbox__feedback_list' }, async $ => {
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

  // A one-row band with a Sketch button: a click, or ctrl+x tab then Enter, does what /sketch does.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const ingesting = await read($, ingestingRef)
    const { Box, Button, Text } = $.ui.resolve(e)
    const sketch = async () => {
      const result = await sketchCompanion($, '')
      if (result !== SKETCH_OPENED) $.ui.toast(result, { timeoutMs: 8000 })
    }
    return (
      <Box>
        <Button key="sketch" label="✎ Sketch" hotkey="s" onPress={() => void sketch()} />
        <Text dimColor> open the companion board for this session</Text>
        {ingesting !== null && <Text dimColor> · Transcribing feedback: {ingesting}…</Text>}
      </Box>
    )
  })

  on('session.end', async ($, e, next) => {
    await endCompanion($, e.sessionId, e.reason !== 'clear').catch(() => undefined)
    return next(e)
  })

  on('command.run', { command: 'sketch' }, async ($, e) => ({ text: await sketchCompanion($, e.args.trim()) }))
}
