import { HERDR_APP_BUNDLE } from './companion-protocol'
import { isOutlinePath } from './generated/output-file'

/**
 * Inside the Herdr app, Herdr Workspaces owns the hand-offs. The band's Sketch and Write open surfaces glued
 * to this terminal, an HTML or Markdown output opens with `hws review`, and the outputs section is shorter.
 */
export type HerdrHost = { terminal: string; hws: string }

/** How long the session-start check gives each `hws --help`. */
export const HWS_CHECK_MS = 2_000
/** How long a surface or review open may take. The host starts before `hws` returns. */
export const HWS_OPEN_MS = 20_000

export const HERDR_SKETCH_OPENED = 'Sketch open in Herdr. Draw, then press Done.'
export const HERDR_WRITE_OPENED = 'Note open in Herdr. Write, then press Done.'

/** The Herdr app terminal this session runs in, or undefined outside the Herdr app. */
export function herdrTerminalOf(env: { __CFBundleIdentifier?: string; HC_TERMINAL_ID?: string }): string | undefined {
  const terminal = env.HC_TERMINAL_ID?.trim()
  return env.__CFBundleIdentifier === HERDR_APP_BUNDLE && terminal ? terminal : undefined
}

/** Where to look for `hws`, in order. The first that runs wins. */
export function hwsCandidates(home: string): string[] {
  return home === '' ? ['hws'] : [`${home}/.local/bin/hws`, 'hws']
}

/** Opens a sketch or note surface glued to the terminal. A title names it. */
export function surfaceArgv(host: HerdrHost, type: 'board' | 'note', title = ''): string[] {
  return [host.hws, 'surface', 'open', '--type', type, ...(title === '' ? [] : ['--title', title]), '--terminal', host.terminal]
}

/** Opens a page beside the terminal for comments. */
export function reviewArgv(host: HerdrHost, file: string): string[] {
  return [host.hws, 'review', file, '--terminal', host.terminal]
}

/** True for an HTML or Markdown file that `hws review` shows. Outlines and links keep Agent Brief's route. */
export function isHerdrReviewable(ref: string): boolean {
  if (/^[a-z][a-z0-9+.-]*:/i.test(ref)) return false
  return /\.(html?|md)$/i.test(ref) && !isOutlinePath(ref)
}

/** What a failed `hws` run toasts: its first stderr line, else its first stdout line, else the exit code. */
export function hwsFailureText(ran: { exitCode: number; stdout?: string; stderr?: string }): string {
  const first = (text = '') => text.split('\n').map(line => line.trim()).find(line => line !== '')
  return first(ran.stderr) ?? first(ran.stdout) ?? `hws exited ${ran.exitCode}`
}
