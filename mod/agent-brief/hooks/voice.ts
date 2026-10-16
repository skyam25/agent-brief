/**
 * Push-to-talk dictation. yap transcribes the microphone on device and the text lands in the prompt box.
 *
 * yap prints its transcript only when it stops. SIGINT makes it print and exit; SIGTERM drops the text.
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
