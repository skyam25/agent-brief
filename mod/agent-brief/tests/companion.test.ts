import { describe, expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { DEFAULT_SOCKET, SESSION_ID, delivery, fakeCompanion } from './companion-world'
import { BAND, CWD, SESSION, command, textOf, worldOf } from './world'

const LAUNCH = 'open -a "Agent Brief"'

/** Seats the world, the mocked clock and the fake app, then starts the session. */
async function setup($: Parameters<TestBody>[0], on: Parameters<TestBody>[1]) {
  const world = worldOf(on)
  const clock = mock.clock(on)
  mock.store(on)
  const app = fakeCompanion(on, clock)
  return { world, clock, app, start: () => $.session.start(SESSION) }
}

describe('registration', () => {
  test('registers when the app answers /health, over the default socket', async ($, on) => {
    const { app, clock, start } = await setup($, on)
    await start()
    await clock.settle()

    expect(app.calls[0]).toMatchObject({ method: 'GET', path: '/health', socketPath: DEFAULT_SOCKET })
    expect(app.to('POST', '/sessions')).toHaveLength(1)
    expect(app.to('POST', '/sessions')[0]!.body).toEqual({ sessionId: SESSION_ID, cwd: CWD, title: 'work' })
    expect(app.to('POST', '/sessions')[0]!.socketPath).toBe(DEFAULT_SOCKET)
  })

  test('uses the companionSocket setting', { options: { companionSocket: '/tmp/c.sock' } }, async ($, on) => {
    const { app, clock, start } = await setup($, on)
    await start()
    await clock.settle()
    expect(app.calls.every(c => c.socketPath === '/tmp/c.sock')).toBe(true)
  })

  test('registers again every 60 s', async ($, on) => {
    const { app, clock, start } = await setup($, on)
    await start()
    await clock.settle()
    expect(app.to('POST', '/sessions')).toHaveLength(1)

    await clock.advance(59_000)
    expect(app.to('POST', '/sessions'), 'not yet').toHaveLength(1)
    await clock.advance(1_000)
    expect(app.to('POST', '/sessions')).toHaveLength(2)
    await clock.advance(60_000)
    expect(app.to('POST', '/sessions')).toHaveLength(3)
  })

  test('session.end deletes the session and stops the loop', async ($, on) => {
    const { app, clock, start } = await setup($, on)
    await start()
    await clock.settle()

    await $.session.end({ reason: 'prompt_input_exit', sessionId: SESSION_ID, resume: { id: SESSION_ID } })
    expect(app.to('DELETE', `/sessions/${SESSION_ID}`)).toHaveLength(1)

    const before = app.calls.length
    await clock.advance(120_000)
    expect(app.calls.length, 'nothing after the end').toBe(before)
  })
})

describe('delivery', () => {
  test('fill puts the exact draft in the box, toasts, then acks', async ($, on) => {
    const { app, world, clock, start } = await setup($, on)
    await start()
    await clock.settle()

    app.push(delivery('d1', '@.feedback/sketches/d1/sketch.png\nMake the header bigger.'))
    await clock.advance(250)

    expect(app.fills).toEqual([{ text: '@.feedback/sketches/d1/sketch.png\nMake the header bigger.', mode: 'append' }])
    expect(app.box.text).toBe('@.feedback/sketches/d1/sketch.png\nMake the header bigger.')
    expect(world.toasts).toEqual(['Sketch from Agent Brief is ready — press Enter'])
    expect(world.submitted).toEqual([])
    expect(app.to('POST', '/deliveries/d1/ack')).toHaveLength(1)
    expect(app.queue).toEqual([])
    expect(app.to('GET', `/deliveries?session=${SESSION_ID}&wait=25`).length).toBeGreaterThan(1)
  })

  test('an idle poll is held for the 25 s wait, then asked again', async ($, on) => {
    const { app, clock, start } = await setup($, on)
    const polls = () => app.to('GET', `/deliveries?session=${SESSION_ID}&wait=25`)
    await start()
    await clock.settle()
    expect(polls()).toHaveLength(1)

    await clock.advance(24_000)
    expect(polls(), 'still held').toHaveLength(1)
    await clock.advance(1_300)
    expect(polls(), 'asked again once the wait ran out').toHaveLength(2)
  })

  test('a delivery that arrives mid-poll lands at once', async ($, on) => {
    const { app, world, clock, start } = await setup($, on)
    await start()
    await clock.settle()

    await clock.advance(5_000)
    expect(app.fills).toEqual([])
    app.push(delivery('d0', 'mid-poll'))
    await clock.settle()

    expect(clock.now(), 'no wait for the 25 s to end').toBe(5_000)
    expect(app.box.text).toBe('mid-poll')
    expect(world.toasts).toHaveLength(1)
    expect(app.to('POST', '/deliveries/d0/ack')).toHaveLength(1)
  })

  test('submit sends the draft as the user and acks', async ($, on) => {
    const { app, world, clock, start } = await setup($, on)
    await start()
    await clock.settle()

    app.push(delivery('d2', 'Look at this.', 'submit'))
    await clock.advance(250)

    expect(world.submitted).toEqual(['Look at this.'])
    expect(app.fills).toEqual([])
    expect(world.toasts).toEqual(['Sent sketch to Claude'])
    expect(app.to('POST', '/deliveries/d2/ack')).toHaveLength(1)
  })

  test('a delivery the app repeats is not filled twice', async ($, on) => {
    const { app, world, clock, start } = await setup($, on)
    await start()
    await clock.settle()

    app.isAckBroken = true
    app.push(delivery('d3', 'once'))
    await clock.advance(1_000)

    expect(app.fills, 'filled once although listed on every poll').toHaveLength(1)
    expect(world.toasts).toHaveLength(1)
    expect(app.to('POST', '/deliveries/d3/ack').length, 'the ack is retried').toBeGreaterThan(1)

    app.isAckBroken = false
    await clock.advance(250)
    expect(app.queue).toEqual([])
    expect(app.fills).toHaveLength(1)
  })

  test('text the user already typed stays, and the draft follows it', async ($, on) => {
    const { app, clock, start } = await setup($, on)
    await start()
    await clock.settle()

    app.box = { text: 'half a thought', cursor: 4 }
    app.push(delivery('d4', 'the sketch'))
    await clock.advance(250)

    expect(app.box.text).toBe('half a thought\n\nthe sketch')
    expect(app.fills[0]!.mode).toBe('append')
    expect(app.to('POST', '/deliveries/d4/ack')).toHaveLength(1)
  })

  test('a refused fill waits and retries without acking', async ($, on) => {
    const { app, world, clock, start } = await setup($, on)
    await start()
    await clock.settle()

    app.isBoxBlocked = true
    app.push(delivery('d5', 'later'))
    await clock.advance(1_000)
    expect(app.fills).toEqual([])
    expect(app.to('POST', '/deliveries/d5/ack')).toHaveLength(0)
    expect(world.toasts).toEqual([])

    app.isBoxBlocked = false
    await clock.advance(2_000)
    expect(app.box.text).toBe('later')
    expect(app.to('POST', '/deliveries/d5/ack')).toHaveLength(1)
  })
})

describe('app down', () => {
  test('backs off 5 s, 10 s, 20 s, 30 s without throwing, then recovers', async ($, on) => {
    const { app, clock, start } = await setup($, on)
    app.isUp = false
    await start()
    await clock.advance(120_000)

    const health = app.to('GET', '/health').map(c => c.at)
    expect(health.slice(0, 5)).toEqual([0, 5_000, 15_000, 35_000, 65_000])
    expect(app.calls.every(c => c.path === '/health'), 'only health is tried while down').toBe(true)

    app.isUp = true
    await clock.advance(30_000)
    expect(app.to('POST', '/sessions')).toHaveLength(1)
    expect(app.to('GET', `/deliveries?session=${SESSION_ID}&wait=25`).length).toBeGreaterThan(0)
  })

  test('a poll that fails sends the loop back to health checks', async ($, on) => {
    const { app, clock, start } = await setup($, on)
    await start()
    await clock.settle()

    app.isUp = false
    await clock.advance(250)
    const lastPoll = app.calls.length
    await clock.advance(5_000)
    expect(app.calls.slice(lastPoll).every(c => c.path === '/health')).toBe(true)

    app.isUp = true
    await clock.advance(10_000)
    expect(app.to('POST', '/sessions'), 'registers again after the app returns').toHaveLength(2)
  })
})

describe('/sketch', () => {
  test('opens the panel for this session when the app is up', async ($, on) => {
    const { app, world, clock, start } = await setup($, on)
    await start()
    await clock.settle()
    expect(world.commands).toContain('sketch')

    const out = await $.command.run(command('sketch', ' a login form '))
    expect(out).toEqual({ text: 'Agent Brief open — sketch, then press Send.' })
    expect(app.to('POST', '/open')[0]!.body).toEqual({ sessionId: SESSION_ID, prompt: 'a login form' })
    expect(world.runs.filter(r => r.argv[0] === 'sh'), 'no launch').toEqual([])
  })

  test('sends no prompt when none is given', async ($, on) => {
    const { app, clock, start } = await setup($, on)
    await start()
    await clock.settle()
    await $.command.run(command('sketch'))
    expect(app.to('POST', '/open')[0]!.body).toEqual({ sessionId: SESSION_ID })
  })

  test('launches the app when it is down, then opens', async ($, on) => {
    const { app, world, clock, start } = await setup($, on)
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
    const { app, world, clock, start } = await setup($, on)
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
    const { app, world, clock, start } = await setup($, on)
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

describe('two sessions', () => {
  test('deliveries queued for another session never reach this box', async ($, on) => {
    const { app, world, clock, start } = await setup($, on)
    await start()
    await clock.settle()

    app.push(delivery('x1', 'for the other session', 'fill', 's2'))
    app.push(delivery('x2', 'sent by the other session', 'submit', 's2'))
    await clock.advance(30_000)
    expect(app.fills).toEqual([])
    expect(world.submitted).toEqual([])
    expect(world.toasts).toEqual([])
    expect(app.queue.map(d => d.id), 'left for their own session to take').toEqual(['x1', 'x2'])
    expect(app.to('POST', '/deliveries/x1/ack')).toHaveLength(0)

    app.push(delivery('m1', 'mine'))
    await clock.advance(250)
    expect(app.box.text).toBe('mine')
    expect(app.queue.map(d => d.id)).toEqual(['x1', 'x2'])
  })

  test('every poll names this session only', async ($, on) => {
    const { app, clock, start } = await setup($, on)
    await start()
    await clock.advance(60_000)
    const polls = app.calls.filter(c => c.path.startsWith('/deliveries?'))
    expect(polls.length).toBeGreaterThan(1)
    expect(polls.every(c => c.path === `/deliveries?session=${SESSION_ID}&wait=25`)).toBe(true)
  })
})

describe('the Sketch button above the prompt', () => {
  test('draws one row with the button, and yields to a survey', async ($, on) => {
    const { clock, start } = await setup($, on)
    await start()
    await clock.settle()
    expect(JSON.stringify(await $.ui.render(BAND))).toContain('"label":"✎ Sketch"')
    const survey = { ...BAND, props: { ...BAND.props, hasSurvey: true } }
    expect(textOf(await $.ui.render(survey))).toBe('engine band')
  })

  test('a press opens the panel for this session, as /sketch does', async ($, on) => {
    const { app, world, clock, start } = await setup($, on)
    await start()
    await clock.settle()
    await $.ui.render(BAND)
    await $.ui.press({ plugin: 'agent-brief', key: 'sketch' })
    expect(app.to('POST', '/open')[0]!.body).toEqual({ sessionId: SESSION_ID })
    expect(world.toasts).toEqual([])
  })

  test('a press says why when the app cannot be reached', async ($, on) => {
    const { app, world, clock, start } = await setup($, on)
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
