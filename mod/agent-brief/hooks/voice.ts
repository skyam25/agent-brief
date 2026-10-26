/**
 * Push-to-talk dictation. yap transcribes the microphone on device and the text lands in the prompt box.
 *
 * yap prints each phrase once it settles, a few seconds after a pause, and the band fills it in right away.
 * SIGINT makes yap print the phrase in progress and exit; SIGTERM drops it.
 * So the band stops it with `kill -INT`, never by ending the stream, which sends SIGTERM.
 */

import type { VoiceState } from '../types'

/** Dictation stops itself after this long. */
export const DICTATION_MAX_MS = 5 * 60_000

/** The shell's exit code when yap is not installed. */
export const YAP_MISSING = 127

/**
 * Prints the shell's pid on the first line, then becomes yap under that pid.
 * Homebrew's folders join PATH because a GUI-launched terminal may lack them.
 */
export const DICTATE_ARGV = [
  'sh',
  '-c',
  'PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"; command -v yap >/dev/null || exit 127; echo "$$"; exec yap dictate --txt',
] as const

/**
 * Puts dictation in at the cursor, as typing would: a space before it when a word ends there,
 * and a space after it when a word starts there.
 */
export function dictationFill(box: { text: string; cursor: number }, said: string): { text: string; mode: 'insert' } {
  const at = Math.max(0, Math.min(box.cursor, box.text.length))
  const before = box.text.slice(0, at)
  const after = box.text.slice(at)
  const lead = before !== '' && !/\s$/.test(before) ? ' ' : ''
  const trail = /^[^\s.,;:!?)\]}]/.test(after) ? ' ' : ''
  return { text: `${lead}${said}${trail}`, mode: 'insert' }
}

/** How long Enter waits for yap's last words before sending without them. */
export const SUBMIT_HOLD_MS = 3000

/** The submitted prompt with the words yap still held when Enter went, after a space. */
export function withDictation(text: string, said: string): string {
  if (said === '') return text
  const typed = text.trimEnd()
  return typed === '' ? said : `${typed} ${said}`
}

export const DICTATION_EMPTY = 'Dictation heard nothing'
export const DICTATION_NO_BOX = 'Could not fill the prompt box, so the dictation is on the clipboard'
export const YAP_MISSING_TEXT = 'Voice needs yap, which transcribes on device: brew install yap'

/** The pid line, once it has arrived, and the transcript after it with its whitespace collapsed. */
export function splitDictation(stdout: string): { pid?: string; text: string } {
  const match = /^\s*(\d+)\n([\s\S]*)$/.exec(stdout)
  if (match === null) return { text: '' }
  return { pid: match[1]!, text: match[2]!.replace(/\s+/g, ' ').trim() }
}

/** Why yap failed, from the end of its stderr. */
export function failureText(stderr: string, code: number | null): string {
  const why = stderr.trim().split('\n').slice(-2).join(' ').slice(0, 200)
  return `Dictation failed: ${why || `exit code ${code}`}`
}

/** `0:07` for seven seconds. */
export function clockText(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

export const listening = (): VoiceState => ({ phase: 'listening', seconds: 0 })

/** One more second while listening; anything else is left alone. */
export const addSecond = (voice: VoiceState | null): VoiceState | null =>
  voice?.phase === 'listening' ? { ...voice, seconds: voice.seconds + 1 } : voice
