import { describe, expect, test } from 'claude-code/testing'

import {
  expandPastes,
  fillRequest,
  itemsInstructions,
  lastReply,
  rememberPaste,
  launchFailureText,
  parseDeliveries,
  hostOf,
  sessionInfo,
  summaryOf,
  socketPathOf,
  trackReply,
  trackTarget,
  trackingOf,
  upkeep,
} from '../hooks/companion-logic'

describe('socketPathOf', () => {
  test('empty setting means the app default', () => {
    expect(socketPathOf('', '/Users/me')).toBe('/Users/me/Library/Application Support/AgentBrief/agent-brief.sock')
    expect(socketPathOf('  ', '/Users/me')).toBe('/Users/me/Library/Application Support/AgentBrief/agent-brief.sock')
  })

  test('a custom path wins, with ~ expanded', () => {
    expect(socketPathOf('/tmp/c.sock', '/Users/me')).toBe('/tmp/c.sock')
    expect(socketPathOf('~/c.sock', '/Users/me')).toBe('/Users/me/c.sock')
  })
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

test('the launch failure names the command, both settings and the download', () => {
  const text = launchFailureText('open -a "Agent Brief"', '/tmp/c.sock')
  expect(text).toContain('open -a "Agent Brief"')
  expect(text).toContain('/tmp/c.sock')
  expect(text).toContain('companionLaunch')
  expect(text).toContain('companionSocket')
  expect(text).toContain('https://github.com/skyam25/agent-brief/releases/latest')
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

  test('carries when the session last replied', () => {
    expect(sessionInfo('s1', '/Users/me/app', { activeAt: 42 })).toMatchObject({ activeAt: 42 })
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

describe('pastes and replies for Write', () => {
  test('keeps what a large paste held and puts it back in place of its placeholder', () => {
    const pastes = new Map<number, string>()
    rememberPaste(pastes, 'see ', 'see [Pasted text #1 +3 lines] now', 'a\nb\nc\nd')
    expect(expandPastes('see [Pasted text #1 +3 lines] now', pastes)).toBe('see a\nb\nc\nd now')
  })

  test('leaves a placeholder it never saw, and ignores an input that is a placeholder', () => {
    const pastes = new Map<number, string>()
    rememberPaste(pastes, '', '[Pasted text #2 +9 lines]', '[Pasted text #2 +9 lines]')
    expect(pastes.size).toBe(0)
    expect(expandPastes('[Pasted text #2 +9 lines] [Image #1]', pastes)).toBe('[Pasted text #2 +9 lines] [Image #1]')
  })

  test('typing next to a placeholder records nothing new', () => {
    const pastes = new Map([[1, 'held']])
    rememberPaste(pastes, '[Pasted text #1 +1 lines]', '[Pasted text #1 +1 lines] x', ' x')
    expect(pastes.get(1)).toBe('held')
  })

  test('the last reply is the newest assistant message with text', () => {
    const msg = (role: string, text: string) => ({ role, text })
    expect(lastReply([])).toBeUndefined()
    expect(lastReply([msg('user', 'hi'), msg('assistant', '  Plan: ship it  '), msg('assistant', ''), msg('user', '/write last')])).toBe('Plan: ship it')
  })
})

describe('item tracking', () => {
  test('the instructions name the items file and the reply ending', () => {
    const text = itemsInstructions('/work/.feedback/items/s1.md')
    expect(text).toContain('Keep the items file at /work/.feedback/items/s1.md.')
    expect(text).toContain('# Items · <short title>')
    expect(text).toContain('`Done: #…`')
    expect(text).toContain('Never edit or remove a `You:` line.')
    expect(text).toContain('add an `Out:` line with its path relative to the project')
  })

  test('trackingOf reads the session body and treats anything else as off', () => {
    expect(trackingOf({ trackItems: true, itemsPath: '/w/i.md' })).toEqual({ trackItems: true, itemsPath: '/w/i.md' })
    expect(trackingOf({ trackItems: 'yes', itemsPath: '' })).toEqual({ trackItems: false })
    expect(trackingOf(undefined)).toEqual({ trackItems: false })
  })

  test('trackTarget takes on, off, or flips', () => {
    expect(trackTarget('on', false)).toBe(true)
    expect(trackTarget(' Off ', true)).toBe(false)
    expect(trackTarget('', false)).toBe(true)
    expect(trackTarget('', true)).toBe(false)
    expect(trackTarget('maybe', true)).toBeUndefined()
  })

  test('trackReply names the items path relative to the project', () => {
    expect(trackReply({ trackItems: true, itemsPath: '/w/.feedback/items/s1.md' }, '/w')).toBe(
      'Item tracking on. Claude keeps items in .feedback/items/s1.md and you answer them in the panel.',
    )
    expect(trackReply({ trackItems: true, itemsPath: '/elsewhere/s1.md' }, '/w')).toContain('items in /elsewhere/s1.md and')
    expect(trackReply({ trackItems: false }, '/w')).toBe('Item tracking off.')
  })
})

describe('upkeep', () => {
  test('a loop with no step for two minutes counts as stopped', () => {
    expect(upkeep(200_000, 199_000, 199_000)).toEqual({ isLoopStale: false, isLapsed: false })
    expect(upkeep(200_000, 79_000, 199_000).isLoopStale).toBe(true)
  })

  test('a registration older than the refresh gap has lapsed', () => {
    expect(upkeep(200_000, 199_000, 139_000).isLapsed).toBe(true)
  })

  test('a loop that never stepped counts from clock zero', () => {
    expect(upkeep(5_000, 0, 0).isLoopStale).toBe(false)
    expect(upkeep(130_000, 0, 0).isLoopStale).toBe(true)
  })
})
