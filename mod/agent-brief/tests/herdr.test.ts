import { describe, expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import {
  HERDR_SKETCH_OPENED,
  HERDR_WRITE_OPENED,
  herdrTerminalOf,
  hwsCandidates,
  hwsFailureText,
  isHerdrReviewable,
  reviewArgv,
  surfaceArgv,
} from '../hooks/herdr-logic'
import { outputsInstructions } from '../hooks/outputs'
import { SESSION_ID, setupCompanion } from './companion-world'
import { BAND, COMPOSE, CWD, HOME, briefPane, command } from './world'

type Dollar = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]

const TERMINAL = 't13'
const HWS = `${HOME}/.local/bin/hws`
const HERDR_ENV = { __CFBundleIdentifier: 'dev.herdr.app', HC_TERMINAL_ID: TERMINAL }
const OUTPUTS_PATH = `${CWD}/.feedback/outputs/${SESSION_ID}.json`

/**
 * The companion world with the session in the Herdr app or outside it.
 * `hws` answers `--help` with 0 unless `isHwsMissing`, and any other command with `hwsAnswer`.
 */
async function setup($: Dollar, on: On, { isHerdr = true, isHwsMissing = false, files = {} as Record<string, string> } = {}) {
  const seated = await setupCompanion($, on)
  if (isHerdr) Object.assign(seated.world.env, HERDR_ENV)
  for (const [path, text] of Object.entries(files)) seated.world.files.set(path, text)
  const hws = { answer: { exitCode: 0, stdout: '{"id":"s1"}', stderr: '' } }
  const fallback = seated.world.answer
  seated.world.answer = argv => {
    if (argv[0] === HWS || argv[0] === 'hws') {
      if (argv[1] === '--help') return isHwsMissing ? { exitCode: 127, stdout: '', stderr: 'command not found: hws' } : { exitCode: 0, stdout: 'usage', stderr: '' }
      return hws.answer
    }
    return fallback(argv)
  }
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [] }))
  on('session.messages', () => ({ value: [] }))
  on('turn.complete', () => ({ text: '' }))
  await seated.start()
  await seated.clock.settle()
  const hwsRuns = () => seated.world.runs.filter(r => r.argv[0] === HWS || r.argv[0] === 'hws').map(r => r.argv)
  const opens = () => hwsRuns().filter(argv => argv[1] !== '--help')
  return { ...seated, hws, hwsRuns, opens }
}

const band = async ($: Dollar) => JSON.stringify(await $.ui.render(BAND))
const pick = ($: Dollar, value: string) => $.ui.select({ plugin: 'agent-brief', key: 'open', value })
const outputsSection = async ($: Dollar) => (await $.prompt.compose(COMPOSE)).sections.find(s => s.id === 'agent-brief:outputs')!.text

describe('Herdr helpers', () => {
  test('a session is in the Herdr app only with its bundle id and a terminal', () => {
    expect(herdrTerminalOf(HERDR_ENV)).toBe(TERMINAL)
    expect(herdrTerminalOf({ __CFBundleIdentifier: 'dev.herdr.app', HC_TERMINAL_ID: ' ' })).toBeUndefined()
    expect(herdrTerminalOf({ __CFBundleIdentifier: 'com.mitchellh.ghostty', HC_TERMINAL_ID: TERMINAL })).toBeUndefined()
    expect(herdrTerminalOf({})).toBeUndefined()
  })

  test('looks for hws in ~/.local/bin first, then on PATH', () => {
    expect(hwsCandidates(HOME)).toEqual([HWS, 'hws'])
    expect(hwsCandidates('')).toEqual(['hws'])
  })

  test('surfaces and reviews are glued to the terminal', () => {
    const host = { terminal: TERMINAL, hws: 'hws' }
    expect(surfaceArgv(host, 'board')).toEqual(['hws', 'surface', 'open', '--type', 'board', '--terminal', TERMINAL])
    expect(surfaceArgv(host, 'board', 'the login flow')).toEqual(['hws', 'surface', 'open', '--type', 'board', '--title', 'the login flow', '--terminal', TERMINAL])
    expect(surfaceArgv(host, 'note')).toEqual(['hws', 'surface', 'open', '--type', 'note', '--terminal', TERMINAL])
    expect(reviewArgv(host, '/p/a.html')).toEqual(['hws', 'review', '/p/a.html', '--terminal', TERMINAL])
  })

  test('hws review takes HTML and Markdown files, but not outlines or links', () => {
    for (const ref of ['a.html', 'docs/b.HTM', '/abs/c.md']) expect(isHerdrReviewable(ref), ref).toBe(true)
    for (const ref of ['plan.outline.md', 'notes.markdown', 'deck.pdf', 'http://localhost:5173/', 'https://x.dev/a.html']) {
      expect(isHerdrReviewable(ref), ref).toBe(false)
    }
  })

  test('a failure toasts the first stderr line', () => {
    expect(hwsFailureText({ exitCode: 1, stderr: '\nno such terminal t13\nat main' })).toBe('no such terminal t13')
    expect(hwsFailureText({ exitCode: 1, stderr: '', stdout: '{"error":"x"}' })).toBe('{"error":"x"}')
    expect(hwsFailureText({ exitCode: 2, stderr: '' })).toBe('hws exited 2')
  })
})

describe('the outputs section', () => {
  test('in Herdr it keeps the declare rules, drops the Agent Brief routes, and is shorter', () => {
    const today = outputsInstructions()
    const herdr = outputsInstructions(false, true)
    expect(herdr.length).toBeLessThan(today.length)
    expect(herdr).toContain('`declare_output`')
    expect(herdr).toContain('`drafting`')
    expect(herdr).toContain('`ready`')
    expect(herdr).toContain('one primary output')
    expect(herdr).toContain('Never declare code')
    expect(herdr).toContain("Herdr's workspace instructions cover showing a page for comments and sending it to the phone")
    expect(herdr).not.toContain('agent-brief note')
    expect(herdr).not.toContain('agent-brief open')
    expect(outputsInstructions(true, true)).toContain('agent-brief output "<title>"')
  })

  test('in Herdr the system prompt carries the Herdr section', async ($, on) => {
    await setup($, on)
    expect(await outputsSection($)).toBe(outputsInstructions(false, true))
  })

  test('outside Herdr the system prompt is today\'s', async ($, on) => {
    await setup($, on, { isHerdr: false })
    expect(await outputsSection($)).toBe(outputsInstructions())
  })

  test('with hws missing the system prompt is today\'s', async ($, on) => {
    await setup($, on, { isHwsMissing: true })
    expect(await outputsSection($)).toBe(outputsInstructions())
  })
})

describe('the band in Herdr', () => {
  test('offers Sketch and Write, with no Stack and no iPad', async ($, on) => {
    const { app, clock } = await setup($, on)
    app.ipadPaired = true
    await clock.advance(90_000)
    const drawn = await band($)
    expect(drawn).toContain('"label":"✎ Sketch"')
    expect(drawn).toContain('"label":"¶ Write"')
    expect(drawn).not.toContain('Stack')
    expect(drawn).not.toContain('↗ iPad')
  })

  test('Sketch opens a board glued to this terminal and never starts Agent Brief', async ($, on) => {
    const { app, world, opens } = await setup($, on)
    await band($)
    await pick($, 'sketch')
    expect(opens()).toEqual([[HWS, 'surface', 'open', '--type', 'board', '--terminal', TERMINAL]])
    expect(app.to('POST', '/open')).toEqual([])
    expect(world.runs.filter(r => r.argv[0] === 'sh')).toEqual([])
    expect(world.toasts).toEqual([])
  })

  test('Write opens a note glued to this terminal and leaves the box', async ($, on) => {
    const { app, opens } = await setup($, on)
    app.box.text = 'a draft'
    await band($)
    await pick($, 'write')
    expect(opens()).toEqual([[HWS, 'surface', 'open', '--type', 'note', '--terminal', TERMINAL]])
    expect(app.box.text).toBe('a draft')
    expect(app.to('POST', '/open')).toEqual([])
  })

  test('a failed hws toasts its first stderr line and opens nothing else', async ($, on) => {
    const { app, world, hws } = await setup($, on)
    hws.answer = { exitCode: 1, stdout: '', stderr: 'terminal t13 has ended\n    at open' }
    await band($)
    await pick($, 'sketch')
    expect(world.toasts).toEqual(['terminal t13 has ended'])
    expect(app.to('POST', '/open')).toEqual([])
    expect(world.runs.filter(r => r.argv[0] === 'sh')).toEqual([])
  })

  test('the check runs ~/.local/bin/hws once at start, and falls back to hws on PATH', async ($, on) => {
    const seated = await setupCompanion($, on)
    Object.assign(seated.world.env, HERDR_ENV)
    seated.world.answer = argv => (argv[0] === HWS ? { exitCode: 127, stdout: '', stderr: 'no such file' } : { exitCode: 0, stdout: '', stderr: '' })
    await seated.start()
    await seated.clock.settle()
    await band($)
    await pick($, 'sketch')
    expect(seated.world.runs.map(r => r.argv)).toEqual([
      [HWS, '--help'],
      ['hws', '--help'],
      ['hws', 'surface', 'open', '--type', 'board', '--terminal', TERMINAL],
    ])
    expect(seated.world.runs[0]!.timeoutMs).toBe(2_000)
  })
})

describe('the band outside Herdr', () => {
  test('shows today\'s picker and iPad, runs no hws, and opens the panel', async ($, on) => {
    const { app, clock, hwsRuns } = await setup($, on, { isHerdr: false })
    app.ipadPaired = true
    await clock.advance(90_000)
    const drawn = await band($)
    expect(drawn).toContain('"label":"▤ Stack"')
    expect(drawn).toContain('"label":"↗ iPad"')
    await pick($, 'sketch')
    expect(app.to('POST', '/open')[0]!.body).toEqual({ sessionId: SESSION_ID })
    expect(hwsRuns()).toEqual([])
  })

  test('a Herdr bundle without a terminal runs no hws', async ($, on) => {
    const seated = await setupCompanion($, on)
    seated.world.env.__CFBundleIdentifier = 'dev.herdr.app'
    await seated.start()
    await seated.clock.settle()
    expect(await band($)).toContain('"label":"▤ Stack"')
    expect(seated.world.runs.filter(r => r.argv[0]?.endsWith('hws'))).toEqual([])
  })

  test('with hws missing the band is today\'s', async ($, on) => {
    const { app, opens } = await setup($, on, { isHwsMissing: true })
    app.ipadPaired = true
    expect(await band($)).toContain('"label":"▤ Stack"')
    await pick($, 'sketch')
    expect(opens()).toEqual([])
    expect(app.to('POST', '/open')[0]!.body).toEqual({ sessionId: SESSION_ID })
  })
})

describe('commands in Herdr', () => {
  test('/sketch opens a board titled with the ask', async ($, on) => {
    const { app, opens } = await setup($, on)
    expect(await $.command.run(command('sketch', ' the login flow '))).toEqual({ text: HERDR_SKETCH_OPENED })
    expect(await $.command.run(command('sketch'))).toEqual({ text: HERDR_SKETCH_OPENED })
    expect(opens()).toEqual([
      [HWS, 'surface', 'open', '--type', 'board', '--title', 'the login flow', '--terminal', TERMINAL],
      [HWS, 'surface', 'open', '--type', 'board', '--terminal', TERMINAL],
    ])
    expect(app.to('POST', '/open')).toEqual([])
  })

  test('/sketch says what hws said when it fails', async ($, on) => {
    const { app, hws } = await setup($, on)
    hws.answer = { exitCode: 1, stdout: '', stderr: 'Pixel is not installed' }
    expect(await $.command.run(command('sketch'))).toEqual({ text: 'Pixel is not installed' })
    expect(app.to('POST', '/open')).toEqual([])
  })

  test('a bare /write opens a note, and /write with text keeps Agent Brief', async ($, on) => {
    const { app, opens } = await setup($, on)
    expect(await $.command.run(command('write'))).toEqual({ text: HERDR_WRITE_OPENED })
    expect(opens()).toEqual([[HWS, 'surface', 'open', '--type', 'note', '--terminal', TERMINAL]])
    await $.command.run(command('write', 'release notes'))
    expect(app.to('POST', '/open')[0]!.body).toEqual({ sessionId: SESSION_ID, mode: 'write', text: 'release notes' })
  })

  test('/stack and /sketch --ipad keep their routes', async ($, on) => {
    const { app, opens } = await setup($, on)
    await $.command.run(command('stack', 'bugs'))
    await $.command.run(command('sketch', '--ipad mark it up'))
    expect(app.to('POST', '/open')[0]!.body).toEqual({ sessionId: SESSION_ID, prompt: 'bugs', layout: 'stack' })
    expect(app.to('POST', '/handoffs')[0]!.body).toEqual({ sessionId: SESSION_ID, prompt: 'mark it up' })
    expect(opens()).toEqual([])
  })

  test('outside Herdr /sketch and /write open the panel', async ($, on) => {
    const { app, hwsRuns } = await setup($, on, { isHerdr: false })
    await $.command.run(command('sketch', 'flow'))
    await $.command.run(command('write'))
    expect(app.to('POST', '/open').map(c => c.body)).toEqual([
      { sessionId: SESSION_ID, prompt: 'flow' },
      { sessionId: SESSION_ID, mode: 'write' },
    ])
    expect(hwsRuns()).toEqual([])
  })
})

const OUTPUTS = JSON.stringify({
  version: 1,
  sessionId: SESSION_ID,
  outputs: [
    { ref: 'docs/spec.md', title: 'Spec', kind: 'markdown', tier: 'declared', status: 'ready', declaredAt: 10 },
    { ref: 'plan.outline.md', title: 'Plan', kind: 'markdown', tier: 'declared', status: 'ready', declaredAt: 20 },
    { ref: 'mock.html', title: 'Mock', kind: 'html', tier: 'declared', status: 'ready', declaredAt: 30 },
  ],
})

const pane = async ($: Dollar) => {
  await $.ui.press({ plugin: 'agent-brief', key: 'brief' })
  return JSON.stringify(await $.ui.render(briefPane()))
}
const pressPane = async ($: Dollar, key: string) => {
  await $.ui.render(briefPane())
  await $.ui.press({ plugin: 'agent-brief', key })
}

describe('opening an output', () => {
  test('in Herdr the Brief pane\'s Open reviews HTML and Markdown, and In Agent Brief leaves those rows', async ($, on) => {
    const { app, world, clock, opens } = await setup($, on, { files: { [OUTPUTS_PATH]: OUTPUTS } })
    await band($)
    const drawn = await pane($)
    await clock.settle()
    expect(drawn).not.toContain('"key":"output-app-docs/spec.md"')
    expect(drawn).not.toContain('"key":"output-app-mock.html"')
    expect(drawn).toContain('"key":"output-app-plan.outline.md"')
    await pressPane($, 'output-open-docs/spec.md')
    await pressPane($, 'output-open-mock.html')
    expect(opens()).toEqual([
      [HWS, 'review', `${CWD}/docs/spec.md`, '--terminal', TERMINAL],
      [HWS, 'review', `${CWD}/mock.html`, '--terminal', TERMINAL],
    ])
    expect(world.runs.filter(r => r.argv[0] === 'open')).toEqual([])
    await pressPane($, 'output-app-plan.outline.md')
    await clock.settle()
    expect(app.to('POST', '/open').at(-1)!.body, 'an outline keeps Agent Brief').toEqual({ sessionId: SESSION_ID, output: { path: 'plan.outline.md' } })
  })

  test('outside Herdr the Brief pane opens as today', async ($, on) => {
    const { world, hwsRuns } = await setup($, on, { isHerdr: false, files: { [OUTPUTS_PATH]: OUTPUTS } })
    await band($)
    const drawn = await pane($)
    expect(drawn).toContain('"key":"output-app-docs/spec.md"')
    await pressPane($, 'output-open-docs/spec.md')
    expect(world.runs.at(-1)!.argv).toEqual(['open', `${CWD}/docs/spec.md`])
    expect(hwsRuns()).toEqual([])
  })

  for (const isHerdr of [true, false]) {
    test(isHerdr ? 'in Herdr the reply row reviews an HTML page' : 'outside Herdr the reply row asks Agent Brief', async ($, on) => {
      const { app, world, clock, opens } = await setup($, on, { isHerdr })
      world.files.set(`${CWD}/prototype/a.html`, '<h1>A</h1>')
      const reply = `Done.\n\n${CWD}/prototype/a.html`
      await $.turn.complete({ answer: reply, durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })
      const ui = await $.ui.mount({
        plugin: 'agent-brief',
        surface: 'terminal',
        component: 'AssistantMessage',
        requestId: 'm1',
        viewport: { columns: 120, rows: 40, isFullscreen: true },
        props: { text: reply, isFirstOfReply: true },
      })
      await ui.press({ key: 'reply-review-0' })
      await clock.settle()
      if (isHerdr) {
        expect(opens()).toEqual([[HWS, 'review', `${CWD}/prototype/a.html`, '--terminal', TERMINAL]])
        expect(app.to('POST', '/open')).toEqual([])
      } else {
        expect(opens()).toEqual([])
        expect(app.to('POST', '/open').at(-1)!.body).toEqual({ sessionId: SESSION_ID, output: { path: 'prototype/a.html' } })
      }
      await ui.unmount()
    })
  }
})
