import type { Delivery, SessionHost, SessionInfo } from './companion-protocol'
import { defaultSocketPath } from './companion-protocol'

export const BACKOFF_MIN_MS = 5_000
export const BACKOFF_MAX_MS = 30_000
export const REREGISTER_MS = 60_000
export const POLL_WAIT_S = 25
/** Gap between polls, so a server that answers at once cannot spin the loop. */
export const POLL_GAP_MS = 250
/** Wait before trying a fill again after the box refused it. */
export const FILL_RETRY_MS = 2_000
/** `/sketch` waits this long for a launched app: attempts times step. */
export const LAUNCH_ATTEMPTS = 40
export const LAUNCH_STEP_S = '0.25'

export const SKETCH_OPENED = 'Agent Brief open — sketch, then press Send.'
export const WRITE_OPENED = 'Agent Brief open — write, then press Send.'
export const STACK_OPENED = 'Agent Brief open in Stack — drop or paste screenshots, talk, then press Send.'

export const ITEMS_SECTION = 'agent-brief:items'
export const TRACK_NOT_RUNNING = 'Agent Brief is not running. Start it, then run /track again.'
export const TRACK_USAGE = 'Use /track, /track on or /track off.'
export const TRACK_UNSUPPORTED = 'This Agent Brief cannot track items. Update to 0.2.6 or newer.'

/** Empty setting means the app's default socket. */
export function socketPathOf(setting: string, home: string): string {
  const custom = setting.trim()
  if (custom === '') return defaultSocketPath(home)
  return custom.startsWith('~/') ? `${home}${custom.slice(1)}` : custom
}

/** Doubles the wait after each failed health check, within the bounds. */
export function nextBackoff(previous: number): number {
  return previous <= 0 ? BACKOFF_MIN_MS : Math.min(previous * 2, BACKOFF_MAX_MS)
}

/**
 * A fill never replaces the box. It appends, after a blank line when the user
 * has already typed something.
 */
export function fillRequest(boxText: string, draft: string): { text: string; mode: 'append' } {
  return { text: boxText.trim() === '' ? draft : `\n\n${draft}`, mode: 'append' }
}

export function toastFor(mode: Delivery['mode']): string {
  return mode === 'fill' ? 'Sketch from Agent Brief is ready — press Enter' : 'Sent sketch to Claude'
}

export function sessionInfo(
  sessionId: string,
  cwd: string,
  extra: { summary?: string; host?: SessionHost } = {},
): SessionInfo {
  return {
    sessionId,
    cwd,
    title: cwd.split('/').filter(Boolean).at(-1) ?? cwd,
    ...(extra.summary ? { summary: extra.summary } : {}),
    ...(extra.host ? { host: extra.host } : {}),
  }
}

export type HostEnv = {
  TERM_PROGRAM?: string
  __CFBundleIdentifier?: string
  HERDR_ENV?: string
  HERDR_PANE_ID?: string
}

/** Where the session runs, from its environment. Undefined when nothing is known. */
export function hostOf(env: HostEnv): SessionHost | undefined {
  const host: SessionHost = {
    ...(env.TERM_PROGRAM ? { terminal: env.TERM_PROGRAM } : {}),
    ...(env.__CFBundleIdentifier ? { bundleId: env.__CFBundleIdentifier } : {}),
    ...(env.HERDR_ENV === '1' && env.HERDR_PANE_ID ? { herdrPane: env.HERDR_PANE_ID } : {}),
  }
  return Object.keys(host).length > 0 ? host : undefined
}

const SUMMARY_MAX = 80

/** The user's latest typed prompt, without slash commands or injected tags, cut to 80 characters. */
export function summaryOf(messages: readonly { role: string; text: string }[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role !== 'user') continue
    const text = m.text
      .replace(/<([a-z][\w-]*)>[\s\S]*?<\/\1>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (!text || text.startsWith('/')) continue
    return text.length <= SUMMARY_MAX ? text : `${text.slice(0, SUMMARY_MAX - 1).trimEnd()}…`
  }
  return undefined
}

export function sessionPath(sessionId: string): string {
  return `/sessions/${encodeURIComponent(sessionId)}`
}

export function deliveriesPath(sessionId: string): string {
  return `/deliveries?session=${encodeURIComponent(sessionId)}&wait=${POLL_WAIT_S}`
}

export function launchFailureText(launch: string, socket: string): string {
  const tried = launch.trim() === '' ? 'No launch command is set.' : `Ran \`${launch}\` and waited 10 s.`
  return `Could not reach Agent Brief at ${socket}. ${tried} Start the app by hand, or fix the companionLaunch and companionSocket settings.`
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** Keeps the well-formed deliveries from a /deliveries body. */
export function parseDeliveries(body: unknown): Delivery[] {
  const list = (body as { deliveries?: unknown } | undefined)?.deliveries
  if (!Array.isArray(list)) return []
  return list.filter(
    (d): d is Delivery =>
      typeof d === 'object' &&
      d !== null &&
      typeof (d as Delivery).id === 'string' &&
      typeof (d as Delivery).draft === 'string' &&
      ((d as Delivery).mode === 'fill' || (d as Delivery).mode === 'submit'),
  )
}

/** How the prompt box shows a large paste: `[Pasted text #2 +40 lines]`. */
const PASTE = /\[Pasted text #(\d+)[^\]]*\]/g

/**
 * Records what a paste held when the edit left a new paste placeholder in the box.
 * An input that is itself a placeholder carries nothing to keep.
 */
export function rememberPaste(pastes: Map<number, string>, before: string, after: string, input: string): void {
  if (input === '' || new RegExp(PASTE.source).test(input)) return
  for (const m of after.matchAll(PASTE)) {
    const n = Number(m[1])
    if (!before.includes(m[0]) && !pastes.has(n)) pastes.set(n, input)
  }
}

/** The box's text with each paste placeholder replaced by what it held, where known. */
export function expandPastes(text: string, pastes: ReadonlyMap<number, string>): string {
  return text.replace(PASTE, (placeholder, n: string) => pastes.get(Number(n)) ?? placeholder)
}

/** Claude's newest reply with text, or undefined before the first one. */
export function lastReply(messages: readonly { role: string; text: string }[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role === 'assistant' && m.text.trim() !== '') return m.text.trim()
  }
  return undefined
}

/** How many finished replies keep their row under the last block. */
export const REPLIES_KEPT = 20

/** `replies` with `answer` last, once, and at most `REPLIES_KEPT` of them. A blank answer changes nothing. */
export function keepReply(replies: readonly string[], answer: string): string[] {
  const text = answer.trim()
  if (text === '') return [...replies]
  return [...replies.filter(r => r !== text), text].slice(-REPLIES_KEPT)
}

const squash = (text: string) => text.replace(/\s+/g, ' ').trim()

/**
 * The finished reply whose last block this is, or undefined. The transcript may hide part of a reply,
 * so a block matches the reply it ends and holds most of. A one-line reply gets no row.
 */
export function replyEndingWith(replies: readonly string[], block: string): string | undefined {
  const tail = squash(block)
  if (tail === '') return undefined
  for (let i = replies.length - 1; i >= 0; i--) {
    const reply = replies[i]!
    if (!reply.includes('\n')) continue
    const whole = squash(reply)
    if (whole.endsWith(tail) && tail.length * 2 >= whole.length) return reply
  }
  return undefined
}

export type Tracking = { trackItems: boolean; itemsPath?: string }

/** Tracking state from a `GET` or `PATCH /sessions/:id` body. Off when the body says nothing. */
export function trackingOf(body: unknown): Tracking {
  const info = (typeof body === 'object' && body !== null ? body : {}) as { trackItems?: unknown; itemsPath?: unknown }
  return {
    trackItems: info.trackItems === true,
    ...(typeof info.itemsPath === 'string' && info.itemsPath !== '' ? { itemsPath: info.itemsPath } : {}),
  }
}

/** The state `/track` asks for: `on`, `off`, or the opposite of now. Undefined for any other word. */
export function trackTarget(args: string, current: boolean): boolean | undefined {
  const word = args.trim().toLowerCase()
  if (word === '') return !current
  if (word === 'on') return true
  if (word === 'off') return false
  return undefined
}

/** What `/track` says, naming the app's items path relative to `cwd` when it is inside it. */
export function trackReply(state: Tracking, cwd: string): string {
  if (!state.trackItems) return 'Item tracking off.'
  const path = state.itemsPath ?? ''
  const shown = path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path
  return `Item tracking on. Claude keeps items in ${shown} and you answer them in the panel.`
}

/** The system prompt section that tells Claude to keep the items file. */
export function itemsInstructions(itemsPath: string): string {
  return `# Item tracking (Agent Brief)

The user turned on item tracking for this session in Agent Brief. They review items in the panel, not in this chat.

Keep the items file at ${itemsPath}. Create its folder if needed. Write it only when the work has distinct items: a brief with several asks, a feedback list, numbered marks on a sketch, a set of questions. For one plain request, do not create the file and do not mention it.

Use exactly this format:

\`\`\`markdown
# Items · <short title>

- [ ] #1 <title>
      Claude: <what you propose, a question, or two options>
      You: <the user's decision, written by them>
      Out: <path of a file you are writing for it, relative to the project>
- [x] #2 <title>
      Claude: done · <what changed>
      Out: <path>
\`\`\`

Rules:
- Number items from 1 in the order they came up. Never renumber or delete an item. Add new ones at the end.
- When something is unclear, put the question or the options on the item as a \`Claude:\` line instead of asking in your reply. The user answers in the panel. Their answers arrive as a message listing the items and their decisions. Act on them and update the file.
- When you create or change a file or screenshot for an item, add an \`Out:\` line with its path relative to the project, one line per file, as soon as the file exists. The panel shows these as links while you work. Keep them when the item is done.
- When you finish an item, change \`[ ]\` to \`[x]\` and add a \`Claude:\` line that says what changed.
- Keep each line short. Details belong in the files you write, not here.
- Never edit or remove a \`You:\` line.
- End every reply that changed an item with two lines, \`Done: #…\` and \`Open: #…\`. Write \`none\` when a list is empty. Leave both lines out when no item changed.
- You may keep the same items in your own todo list while you work. The file is the record the user sees.`
}
