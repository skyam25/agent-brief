import { describe, expect, test } from 'claude-code/testing'

import { expandHome, parseIngestOutput, pickSession, staleRecordings } from '../hooks/logic'
import type { FeedbackInboxSession } from '../types'

const session = (name: string, ingestedAt: number, isConsumed = false): FeedbackInboxSession => ({
  name,
  dir: `/w/.feedback/${name}`,
  reportPath: `/w/.feedback/${name}/report.md`,
  screenshots: [],
  counts: { annotations: 1, notes: 0, utterances: 1, markers: 0 },
  ingestedAt,
  isConsumed,
})

describe('logic', () => {
  test('picks by name, else newest unconsumed, else newest', () => {
    const all = [session('old', 1), session('new', 2, true)]
    expect(pickSession(all)?.name).toBe('old')
    expect(pickSession(all, 'new')?.name).toBe('new')
    expect(pickSession([session('x', 1, true), session('y', 2, true)])?.name).toBe('y')
  })

  test('reads the CLI line, or falls back to stderr', () => {
    expect(parseIngestOutput('noise\n{"ok":false,"error":"bad zip"}\n', '', 1)).toEqual({ ok: false, error: 'bad zip' })
    expect(parseIngestOutput('', 'node: not found', 127)).toEqual({ ok: false, error: 'node: not found' })
    expect(parseIngestOutput('', '', 9)).toEqual({ ok: false, error: 'exit code 9' })
  })

  test('expands ~ against HOME', () => {
    expect(expandHome('~/Downloads/x', '/h')).toBe('/h/Downloads/x')
    expect(expandHome('/abs', '/h')).toBe('/abs')
  })
})

describe('staleRecordings', () => {
  const root = '/p/.feedback'
  const rec = (name: string, isConsumed: boolean, ingestedAt: number, dir = `${root}/${name}`) =>
    ({ name, dir, reportPath: `${dir}/report.md`, screenshots: [], counts: null, ingestedAt, isConsumed })
  test('picks applied recordings older than the cutoff, inside .feedback only', () => {
    const sessions = [rec('old-applied', true, 10), rec('old-new', false, 10), rec('fresh', true, 90), rec('elsewhere', true, 10, '/other/elsewhere')]
    expect(staleRecordings(sessions, root, 50).map(s => s.name)).toEqual(['old-applied'])
  })
})
