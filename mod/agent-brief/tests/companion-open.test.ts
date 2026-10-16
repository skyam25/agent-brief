import { describe, expect, test } from 'claude-code/testing'

import { DEFAULT_SOCKET, SESSION_ID, setupCompanion } from './companion-world'
import { BAND, command, textOf } from './world'

const LAUNCH = 'open -a "Agent Brief"'

describe('/sketch', () => {
  test('opens the panel for this session when the app is up', async ($, on) => {
    const { app, world, clock, start } = await setupCompanion($, on)
    await start()
    await clock.settle()
    expect(world.commands).toContain('sketch')

    const out = await $.command.run(command('sketch', ' a login form '))
    expect(out).toEqual({ text: 'Agent Brief open — sketch, then press Send.' })
    expect(app.to('POST', '/open')[0]!.body).toEqual({ sessionId: SESSION_ID, prompt: 'a login form' })
    expect(world.runs.filter(r => r.argv[0] === 'sh'), 'no launch').toEqual([])
  })

  test('/stack opens the session board in the Stack layout', async ($, on) => {
    const { app, world, clock, start } = await setupCompanion($, on)
    await start()
    await clock.settle()
    expect(world.commands).toContain('stack')
    const out = await $.command.run(command('stack', ' checkout bugs '))
    expect(out).toEqual({ text: 'Agent Brief open in Stack — drop or paste screenshots, talk, then press Send.' })
    expect(app.to('POST', '/open')[0]!.body).toEqual({ sessionId: SESSION_ID, prompt: 'checkout bugs', layout: 'stack' })
  })

  test('/write opens a new note for this session, starting with the words after it', async ($, on) => {
    const { app, world, clock, start } = await setupCompanion($, on)
    await start()
    await clock.settle()
    expect(world.commands).toContain('write')
    const out = await $.command.run(command('write', ' release notes '))
    expect(out).toEqual({ text: 'Agent Brief open — write, then press Send.' })
    expect(app.to('POST', '/open')[0]!.body).toEqual({ sessionId: SESSION_ID, mode: 'write', text: 'release notes' })
  })

  test('/write last puts Claude\'s newest reply in the note', async ($, on) => {
    const { app, clock, start } = await setupCompanion($, on)
    on('session.messages', () => ({ value: [
      { role: 'user', text: 'plan it', toolUses: [] },
      { role: 'assistant', text: 'Plan:\n1. Add the button', toolUses: [] },
    ] }))
    await start()
    await clock.settle()
    await $.command.run(command('write', 'last'))
    expect(app.to('POST', '/open')[0]!.body).toEqual({ sessionId: SESSION_ID, mode: 'write', text: 'Plan:\n1. Add the button' })
  })

  test('/write last says so before Claude has replied', async ($, on) => {
    const { app, clock, start } = await setupCompanion($, on)
    on('session.messages', () => ({ value: [] }))
    await start()
    await clock.settle()
    expect(await $.command.run(command('write', 'last'))).toEqual({ text: 'Claude has not replied yet in this session.' })
    expect(app.to('POST', '/open')).toEqual([])
  })

  test('sends no prompt when none is given', async ($, on) => {
    const { app, clock, start } = await setupCompanion($, on)
    await start()
    await clock.settle()
    await $.command.run(command('sketch'))
    expect(app.to('POST', '/open')[0]!.body).toEqual({ sessionId: SESSION_ID })
  })

  test('launches the app when it is down, then opens', async ($, on) => {
    const { app, world, clock, start } = await setupCompanion($, on)
    app.isUp = false
    let sleeps = 0
    world.answer = argv => {
      if (argv[0] === 'sh') return { exitCode: 0, stdout: '', stderr: '' }
      if (argv[0] === 'sleep' && ++sleeps === 3) app.isUp = true
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    await start()
    await clock.settle()

    const out = await $.command.run(command('sketch', 'draw the flow'))
    expect(out).toEqual({ text: 'Agent Brief open — sketch, then press Send.' })
    expect(world.runs.find(r => r.argv[0] === 'sh')?.argv).toEqual(['sh', '-c', LAUNCH])
    expect(sleeps).toBe(3)
    expect(app.to('POST', '/sessions').length).toBeGreaterThan(0)
    expect(app.to('POST', '/open')[0]!.body).toEqual({ sessionId: SESSION_ID, prompt: 'draw the flow' })
  })

  test('uses the companionLaunch setting', { options: { companionLaunch: 'my-launcher --go' } }, async ($, on) => {
    const { app, world, clock, start } = await setupCompanion($, on)
    app.isUp = false
    world.answer = argv => {
      if (argv[0] === 'sh') app.isUp = true
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    await start()
    await clock.settle()
    await $.command.run(command('sketch'))
    expect(world.runs.find(r => r.argv[0] === 'sh')?.argv).toEqual(['sh', '-c', 'my-launcher --go'])
  })

  test('reports the failure after 10 s of waiting', async ($, on) => {
    const { app, world, clock, start } = await setupCompanion($, on)
    app.isUp = false
    await start()
    await clock.settle()

    const out = (await $.command.run(command('sketch'))) as { text: string }
    expect(out.text).toContain(LAUNCH)
    expect(out.text).toContain('companionSocket')
    expect(out.text).toContain(DEFAULT_SOCKET)
    const sleeps = world.runs.filter(r => r.argv[0] === 'sleep')
    expect(sleeps, '40 waits of 0.25 s make 10 s').toHaveLength(40)
    expect(sleeps[0]!.argv).toEqual(['sleep', '0.25'])
    expect(app.to('POST', '/open')).toHaveLength(0)
  })
})

describe('the Sketch and Write buttons above the prompt', () => {
  test('draws one row with both buttons, and yields to a survey', async ($, on) => {
    const { clock, start } = await setupCompanion($, on)
    await start()
    await clock.settle()
    const band = JSON.stringify(await $.ui.render(BAND))
    expect(band).toContain('"label":"✎ Sketch"')
    expect(band).toContain('"label":"▤ Stack"')
    expect(band).toContain('"label":"¶ Write"')
    expect(band).toContain('"label":"☐ Track"')
    const survey = { ...BAND, props: { ...BAND.props, hasSurvey: true } }
    expect(textOf(await $.ui.render(survey))).toBe('engine band')
  })

  test('a press opens the panel for this session, as /sketch does', async ($, on) => {
    const { app, world, clock, start } = await setupCompanion($, on)
    await start()
    await clock.settle()
    await $.ui.render(BAND)
    await $.ui.press({ plugin: 'agent-brief', key: 'sketch' })
    expect(app.to('POST', '/open')[0]!.body).toEqual({ sessionId: SESSION_ID })
    expect(world.toasts).toEqual([])
  })

  test('a Stack press opens the session board in the Stack layout', async ($, on) => {
    const { app, world, clock, start } = await setupCompanion($, on)
    await start()
    await clock.settle()
    await $.ui.render(BAND)
    await $.ui.press({ plugin: 'agent-brief', key: 'stack' })
    expect(app.to('POST', '/open')[0]!.body).toEqual({ sessionId: SESSION_ID, layout: 'stack' })
    expect(world.toasts).toEqual([])
  })

  test("a Write press with an empty box puts Claude's last reply in the note", async ($, on) => {
    const { app, world, clock, start } = await setupCompanion($, on)
    on('session.messages', () => ({ value: [
      { role: 'user', text: 'draft the post', toolUses: [] },
      { role: 'assistant', text: 'We shipped **v2**.', toolUses: [] },
    ] }))
    await start()
    await clock.settle()
    await $.ui.render(BAND)
    await $.ui.press({ plugin: 'agent-brief', key: 'write' })
    expect(app.to('POST', '/open')[0]!.body).toEqual({ sessionId: SESSION_ID, mode: 'write', text: 'We shipped **v2**.' })
    expect(app.fills, 'the empty box is left alone').toEqual([])
    expect(world.toasts).toEqual([])
  })

  test('a Write press with an empty box opens an empty note before Claude has replied', async ($, on) => {
    const { app, world, clock, start } = await setupCompanion($, on)
    on('session.messages', () => ({ value: [] }))
    await start()
    await clock.settle()
    await $.ui.render(BAND)
    await $.ui.press({ plugin: 'agent-brief', key: 'write' })
    expect(app.to('POST', '/open')[0]!.body).toEqual({ sessionId: SESSION_ID, mode: 'write' })
    expect(world.toasts).toEqual([])
  })

  test('a Write press moves the prompt box draft into the note and empties the box', async ($, on) => {
    const { app, clock, start } = await setupCompanion($, on)
    await start()
    await clock.settle()
    app.box.text = 'half a thought'
    await $.ui.render(BAND)
    await $.ui.press({ plugin: 'agent-brief', key: 'write' })
    expect(app.to('POST', '/open')[0]!.body).toEqual({ sessionId: SESSION_ID, mode: 'write', text: 'half a thought' })
    expect(app.box.text).toBe('')
  })

  test('the box keeps its draft when the app is too old to take it', async ($, on) => {
    const { app, clock, start } = await setupCompanion($, on)
    app.isOldApp = true
    await start()
    await clock.settle()
    app.box.text = 'keep me too'
    await $.ui.render(BAND)
    await $.ui.press({ plugin: 'agent-brief', key: 'write' })
    expect(app.to('POST', '/open')).toHaveLength(1)
    expect(app.box.text).toBe('keep me too')
  })

  test('the box keeps its draft when the app cannot be reached', async ($, on) => {
    const { app, clock, start } = await setupCompanion($, on)
    app.isUp = false
    await start()
    await clock.settle()
    app.box.text = 'keep me'
    await $.ui.render(BAND)
    await $.ui.press({ plugin: 'agent-brief', key: 'write' })
    expect(app.box.text).toBe('keep me')
  })

  test('a press says why when the app cannot be reached', async ($, on) => {
    const { app, world, clock, start } = await setupCompanion($, on)
    app.isUp = false
    await start()
    await clock.settle()
    await $.ui.render(BAND)
    await $.ui.press({ plugin: 'agent-brief', key: 'sketch' })
    expect(world.toasts).toHaveLength(1)
    expect(world.toasts[0]).toContain('Could not reach Agent Brief')
    expect(app.to('POST', '/open')).toHaveLength(0)
  })
})

