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
