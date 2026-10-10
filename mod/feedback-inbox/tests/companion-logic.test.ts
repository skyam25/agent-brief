import { describe, expect, test } from 'claude-code/testing'

import {
  fillRequest,
  launchFailureText,
  nextBackoff,
  parseDeliveries,
  hostOf,
  sessionInfo,
  summaryOf,
  socketPathOf,
  toastFor,
} from '../hooks/companion-logic'

describe('socketPathOf', () => {
  test('empty setting means the app default', () => {
    expect(socketPathOf('', '/Users/me')).toBe('/Users/me/Library/Application Support/WebAgentCompanion/companion.sock')
    expect(socketPathOf('  ', '/Users/me')).toBe('/Users/me/Library/Application Support/WebAgentCompanion/companion.sock')
  })

  test('a custom path wins, with ~ expanded', () => {
    expect(socketPathOf('/tmp/c.sock', '/Users/me')).toBe('/tmp/c.sock')
    expect(socketPathOf('~/c.sock', '/Users/me')).toBe('/Users/me/c.sock')
  })
})

test('backoff doubles from 5 s to a 30 s cap', () => {
  let wait = 0
  const seen: number[] = []
  for (let i = 0; i < 6; i++) seen.push((wait = nextBackoff(wait)))
  expect(seen).toEqual([5000, 10000, 20000, 30000, 30000, 30000])
})

describe('fillRequest', () => {
  test('an empty box takes the draft as is', () => {
    expect(fillRequest('', 'hello')).toEqual({ text: 'hello', mode: 'append' })
    expect(fillRequest('  \n', 'hello')).toEqual({ text: 'hello', mode: 'append' })
  })

  test('typed text stays, and the draft goes after a blank line', () => {
    expect(fillRequest('half a thought', 'hello')).toEqual({ text: '\n\nhello', mode: 'append' })
  })
})

test('parseDeliveries keeps only well-formed entries', () => {
  const good = { id: 'a', sessionId: 's', dir: '/d', draft: 'x', mode: 'fill', createdAt: 1 }
  expect(parseDeliveries({ deliveries: [good, { id: 'b' }, null, { ...good, mode: 'nope' }] })).toEqual([good])
  expect(parseDeliveries(undefined)).toEqual([])
  expect(parseDeliveries({ deliveries: 'x' })).toEqual([])
})

test('toasts and session info', () => {
  expect(toastFor('fill')).toBe('Sketch from the companion is ready — press Enter')
  expect(toastFor('submit')).toBe('Sent sketch to Claude')
  expect(sessionInfo('s1', '/Users/me/app')).toEqual({ sessionId: 's1', cwd: '/Users/me/app', title: 'app' })
})

test('the launch failure names the command and both settings', () => {
  const text = launchFailureText('open -a "Web Agent Companion"', '/tmp/c.sock')
  expect(text).toContain('open -a "Web Agent Companion"')
  expect(text).toContain('/tmp/c.sock')
  expect(text).toContain('companionLaunch')
  expect(text).toContain('companionSocket')
})

describe('session label', () => {
  test('carries the host and summary when known', () => {
    const host = { terminal: 'ghostty', bundleId: 'com.mitchellh.ghostty' }
    expect(sessionInfo('s1', '/Users/me/app', { summary: 'fix it', host })).toEqual({
      sessionId: 's1',
      cwd: '/Users/me/app',
      title: 'app',
      summary: 'fix it',
      host,
    })
  })

  test('reads the terminal, its app and the herdr pane from the environment', () => {
    expect(hostOf({})).toBeUndefined()
    expect(hostOf({ TERM_PROGRAM: 'ghostty', __CFBundleIdentifier: 'com.mitchellh.ghostty' })).toEqual({
      terminal: 'ghostty',
      bundleId: 'com.mitchellh.ghostty',
    })
    expect(hostOf({ HERDR_PANE_ID: 'w1:p2' }), 'a pane id outside herdr is ignored').toBeUndefined()
    expect(hostOf({ HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p2' })).toEqual({ herdrPane: 'w1:p2' })
  })

  test('summarizes the latest typed prompt, skipping commands and injected tags', () => {
    const user = (text: string) => ({ role: 'user', text })
    expect(summaryOf([])).toBeUndefined()
    expect(
      summaryOf([
        user('make the header shorter'),
        { role: 'assistant', text: 'done' },
        user('<command-name>/sketch</command-name><command-args></command-args>'),
        user('/apply-feedback'),
      ]),
    ).toBe('make the header shorter')
    expect(summaryOf([user('<system-reminder>ctx</system-reminder>  ship   it  ')])).toBe('ship it')
    const long = summaryOf([user('word '.repeat(40))])!
    expect(long).toHaveLength(80)
    expect(long.endsWith('…')).toBe(true)
  })
})
