import type { On } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'
import type { MockClock, TestBody } from 'claude-code/testing'

import {
  DICTATE_ARGV,
  DICTATION_EMPTY,
  DICTATION_MAX_MS,
  DICTATION_NO_BOX,
  YAP_MISSING_TEXT,
  addSecond,
  clockText,
  splitDictation,
} from '../hooks/voice'
import { setupCompanion } from './companion-world'
import type { World } from './world'
import { BAND } from './world'

const PID = '4242'
const SAID = 'Rename the Pricing heading to Plans.'

type FakeYap = { spawned: (readonly string[])[]; killed: string[]; copied: string[] }

/**
 * Seats a yap that prints its pid, listens until `kill -INT`, then prints what it heard.
 * `code` 127 stands for a missing yap, which prints nothing.
 */
function fakeYap(on: On, world: World, clock: MockClock, { heard = SAID, code = 0 } = {}): FakeYap {
  const yap: FakeYap = { spawned: [], killed: [], copied: [] }
  let release = () => {}
  const interrupted = new Promise<void>(resolve => (release = resolve))
  const answer = world.answer
  world.answer = argv => {
    if (argv[0] !== 'kill') return answer(argv)
    yap.killed.push(`${argv[1]} ${argv[2]}`)
    release()
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  on('process.spawn', async function* ($, e) {
    yap.spawned.push(e.argv)
    if (code === 127) return { value: { code, signal: null } }
    yield { stream: 'stdout' as const, text: `${PID}\n` }
    await Promise.race([interrupted, clock.sleep(60 * 60_000)])
    if (heard !== '') yield { stream: 'stdout' as const, text: `${heard}\n` }
    return { value: { code, signal: null } }
  })
  on('ui.copy', ($, e) => {
    yap.copied.push(e.text)
    return { value: { isCopied: true as const } }
  })
  return yap
}

const bandText = async ($: Parameters<TestBody>[0]) => JSON.stringify(await $.ui.render(BAND))

describe('voice helpers', () => {
  test('splitDictation takes the pid line, then the transcript with its whitespace collapsed', () => {
    expect(splitDictation('')).toEqual({ text: '' })
    expect(splitDictation('42')).toEqual({ text: '' })
    expect(splitDictation('42\n')).toEqual({ pid: '42', text: '' })
    expect(splitDictation('42\nOne.  Two\nthree. \n')).toEqual({ pid: '42', text: 'One. Two three.' })
  })

  test('clockText reads minutes and seconds', () => {
    expect(clockText(0)).toBe('0:00')
    expect(clockText(7)).toBe('0:07')
    expect(clockText(125)).toBe('2:05')
  })

  test('addSecond counts only while listening', () => {
    expect(addSecond({ phase: 'listening', seconds: 2 })).toEqual({ phase: 'listening', seconds: 3 })
    expect(addSecond({ phase: 'finishing', seconds: 2 })).toEqual({ phase: 'finishing', seconds: 2 })
    expect(addSecond(null)).toBe(null)
  })
})

describe('the Talk button', () => {
  test('dictates into the prompt box: press to listen, press again to stop', async ($, on) => {
    const { app, world, clock, start } = await setupCompanion($, on)
    const yap = fakeYap(on, world, clock)
    await start()
    await clock.settle()
    expect(await bandText($)).toContain('"label":"🎙 Talk"')

    await $.ui.press({ plugin: 'agent-brief', key: 'talk' })
    await clock.settle()
    expect(yap.spawned).toEqual([DICTATE_ARGV])
    expect(await bandText($)).toContain('"label":"■ Stop"')
    await clock.advance(3000)
    expect(await bandText($)).toContain('Listening 0:03')

    await $.ui.press({ plugin: 'agent-brief', key: 'talk' })
    await clock.settle()
    expect(yap.killed).toEqual([`-INT ${PID}`])
    expect(app.fills).toEqual([{ text: SAID, mode: 'append' }])
    expect(world.toasts).toEqual([])
    expect(await bandText($)).toContain('"label":"🎙 Talk"')
  })

  test('appends after a blank line when the box already holds a draft', async ($, on) => {
    const { app, world, clock, start } = await setupCompanion($, on)
    fakeYap(on, world, clock)
    app.box.text = 'Two things:'
    await start()
    await clock.settle()
    await $.ui.render(BAND)
    await $.ui.press({ plugin: 'agent-brief', key: 'talk' })
    await clock.settle()
    await $.ui.press({ plugin: 'agent-brief', key: 'talk' })
    await clock.settle()
    expect(app.box.text).toBe(`Two things:\n\n${SAID}`)
  })

  test('stops by itself after five minutes and still fills the box', async ($, on) => {
    const { app, world, clock, start } = await setupCompanion($, on)
    const yap = fakeYap(on, world, clock)
    await start()
    await clock.settle()
    await $.ui.render(BAND)
    await $.ui.press({ plugin: 'agent-brief', key: 'talk' })
    await clock.advance(DICTATION_MAX_MS)
    await clock.settle()
    expect(yap.killed).toEqual([`-INT ${PID}`])
    expect(app.fills).toEqual([{ text: SAID, mode: 'append' }])
  })

  test('says so when yap heard nothing, and leaves the box alone', async ($, on) => {
    const { app, world, clock, start } = await setupCompanion($, on)
    fakeYap(on, world, clock, { heard: '' })
    await start()
    await clock.settle()
    await $.ui.render(BAND)
    await $.ui.press({ plugin: 'agent-brief', key: 'talk' })
    await clock.settle()
    await $.ui.press({ plugin: 'agent-brief', key: 'talk' })
    await clock.settle()
    expect(app.fills).toEqual([])
    expect(world.toasts).toEqual([DICTATION_EMPTY])
  })

  test('names the install command when yap is missing', async ($, on) => {
    const { app, world, clock, start } = await setupCompanion($, on)
    fakeYap(on, world, clock, { code: 127 })
    await start()
    await clock.settle()
    await $.ui.render(BAND)
    await $.ui.press({ plugin: 'agent-brief', key: 'talk' })
    await clock.settle()
    expect(world.toasts).toEqual([YAP_MISSING_TEXT])
    expect(app.fills).toEqual([])
    expect(await bandText($)).toContain('"label":"🎙 Talk"')
  })

  test('a box that refuses the fill leaves the words on the clipboard', async ($, on) => {
    const { app, world, clock, start } = await setupCompanion($, on)
    const yap = fakeYap(on, world, clock)
    app.isBoxBlocked = true
    await start()
    await clock.settle()
    await $.ui.render(BAND)
    await $.ui.press({ plugin: 'agent-brief', key: 'talk' })
    await clock.settle()
    await $.ui.press({ plugin: 'agent-brief', key: 'talk' })
    await clock.settle()
    expect(yap.copied).toEqual([SAID])
    expect(world.toasts).toEqual([DICTATION_NO_BOX])
  })
})
