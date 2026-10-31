import type { FeedbackInboxCounts, FeedbackInboxSession } from '../types'

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** Annotations, then spoken plus typed notes; zero counts are left out. */
export function countsText(counts: FeedbackInboxCounts | null): string[] {
  if (counts === null) return []
  const notes = counts.notes + counts.utterances
  const parts: string[] = []
  if (counts.annotations > 0) parts.push(plural(counts.annotations, 'annotation'))
  if (notes > 0) parts.push(plural(notes, 'note'))
  return parts
}

/** The prompt `/apply-feedback` submits. */
export const feedbackPrompt = (name: string) =>
  `Read .feedback/${name}/report.md and the screenshots it references. ` +
  'Blockquotes and annotations are my feedback. Summarize what I asked for, then do it.'

/** The named session, else the newest unconsumed, else the newest. Ties go to the later entry. */
export function pickSession(
  sessions: readonly FeedbackInboxSession[],
  name?: string,
): FeedbackInboxSession | undefined {
  const sorted = sessions
    .map((s, i) => ({ s, i }))
    .sort((a, b) => b.s.ingestedAt - a.s.ingestedAt || b.i - a.i)
    .map(({ s }) => s)
  if (name) return sorted.find(s => s.name === name)
  return sorted.find(s => !s.isConsumed) ?? sorted[0]
}

export function markConsumed(
  sessions: readonly FeedbackInboxSession[],
  name: string,
): FeedbackInboxSession[] {
  return sessions.map(s => (s.name === name ? { ...s, isConsumed: true } : s))
}

/** Applied recordings ingested before `cutoff` whose folders sit directly in `root`, the project's `.feedback`. */
export function staleRecordings(sessions: readonly FeedbackInboxSession[], root: string, cutoff: number): FeedbackInboxSession[] {
  return sessions.filter(s => s.isConsumed && s.ingestedAt < cutoff && s.dir === `${root}/${s.name}` && !s.name.includes('/') && !s.name.startsWith('.'))
}

/** Adds or replaces one session by name. */
export function upsert(
  sessions: readonly FeedbackInboxSession[],
  session: FeedbackInboxSession,
): FeedbackInboxSession[] {
  return [...sessions.filter(s => s.name !== session.name), session]
}

export function latestText(session: FeedbackInboxSession, report: string): string {
  const shots = session.screenshots.length > 0
    ? session.screenshots.map(p => `- ${p}`).join('\n')
    : '- (none)'
  return [
    `Feedback session "${session.name}" from ${session.reportPath}.`,
    'Blockquotes (🎙️ narration) and annotations are the user\'s feedback; the other lines are context for what they were looking at.',
    'Screenshot paths in the report are relative to that folder. Open a screenshot with Read when a line references it.',
    '',
    report.trim(),
    '',
    'Screenshots:',
    shots,
  ].join('\n')
}

export function listText(sessions: readonly FeedbackInboxSession[]): string {
  if (sessions.length === 0) return 'No feedback sessions in .feedback/ yet.'
  return [...sessions]
    .sort((a, b) => b.ingestedAt - a.ingestedAt)
    .map(s => {
      const counts = countsText(s.counts)
      const state = s.isConsumed ? 'applied' : 'new'
      return `- ${s.name} [${state}]${counts.length > 0 ? ` ${counts.join(', ')}` : ''}: ${s.reportPath}`
    })
    .join('\n')
}

export type IngestOk = {
  ok: true
  name: string
  dir: string
  reportPath: string
  screenshots: string[]
  counts: FeedbackInboxCounts
}

export type IngestOutcome = IngestOk | { ok: false; error: string }

/** The CLI's last stdout line as JSON; anything else is a failure. */
export function parseIngestOutput(stdout: string, stderr: string, exitCode: number): IngestOutcome {
  const line = stdout.trim().split('\n').at(-1) ?? ''
  try {
    const parsed = JSON.parse(line) as { ok?: boolean; name?: unknown; reportPath?: unknown; error?: string }
    if (parsed.ok === true && typeof parsed.name === 'string' && typeof parsed.reportPath === 'string') {
      return parsed as IngestOk
    }
    if (parsed.ok === false) return { ok: false, error: parsed.error ?? 'ingest failed' }
  } catch {
    // Not JSON: fall through to the process's own words.
  }
  const why = stderr.trim().split('\n').slice(-2).join(' ') || line || `exit code ${exitCode}`
  return { ok: false, error: why.slice(0, 300) }
}

/** Counts from a session.json's events, as the ingest CLI computes them. */
export function countEvents(json: unknown): FeedbackInboxCounts | null {
  const events = (json as { events?: unknown })?.events
  if (!Array.isArray(events)) return null
  const counts: FeedbackInboxCounts = { annotations: 0, notes: 0, utterances: 0, markers: 0 }
  for (const e of events as { type?: string; payload?: { transcript?: unknown } }[]) {
    if (e.type === 'annotation') counts.annotations += 1
    else if (e.type === 'note') counts.notes += 1
    else if (e.type === 'marker') counts.markers += 1
    else if (e.type === 'voice-segment' && typeof e.payload?.transcript === 'string' && e.payload.transcript.trim()) {
      counts.utterances += 1
    }
  }
  return counts
}

/** Expands a leading `~/` against HOME. */
export const expandHome = (path: string, home: string) =>
  path === '~' ? home : path.startsWith('~/') ? `${home}${path.slice(1)}` : path
