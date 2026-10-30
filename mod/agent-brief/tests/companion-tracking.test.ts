import { describe, expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { SESSION_ID, setupCompanion } from './companion-world'
import { COMPOSE, CWD, briefPane, command } from './world'

describe('item tracking', () => {
  const ITEMS = `${CWD}/.feedback/items/${SESSION_ID}.md`
  const ids = async ($: Parameters<TestBody>[0]) => (await $.prompt.compose(COMPOSE)).sections.map(s => s.id)
  const itemsText = async ($: Parameters<TestBody>[0]) =>
    (await $.prompt.compose(COMPOSE)).sections.find(s => s.id === 'agent-brief:items')

  test('adds the items section only while tracking is on', async ($, on) => {
    const { app, clock, start } = await setupCompanion($, on)
    await start()
    await clock.settle()
    expect(await ids($), 'off by default').toEqual(['intro', 'agent-brief:outputs'])
    expect(app.to('GET', `/sessions/${SESSION_ID}`)).toHaveLength(1)

    app.sessions.get(SESSION_ID)!.trackItems = true
    const section = await itemsText($)
    expect(section?.scope).toBe('session')
    expect(section?.text).toContain(ITEMS)
    expect(await ids($)).toEqual(['intro', 'agent-brief:items', 'agent-brief:outputs'])

    app.sessions.get(SESSION_ID)!.trackItems = false
    expect(await ids($), 'off again').toEqual(['intro', 'agent-brief:outputs'])
  })

  test('a folder file with track: on turns tracking on once for a new session', async ($, on) => {
    const { app, world, clock, start } = await setupCompanion($, on)
    world.files.set(`${CWD}/.claude/agent-brief.local.md`, '---\ntrack: on\n---\n')
    await start()
    await clock.settle()
    expect(await ids($)).toEqual(['intro', 'agent-brief:items', 'agent-brief:outputs'])
    expect(app.sessions.get(SESSION_ID)!.trackItems).toBe(true)

    app.sessions.get(SESSION_ID)!.trackItems = false
    expect(await ids($), 'a later toggle stands').toEqual(['intro', 'agent-brief:outputs'])
  })

  test('keeps the last answer when the app stops answering', async ($, on) => {
    const { app, clock, start } = await setupCompanion($, on)
    await start()
    await clock.settle()
    app.sessions.get(SESSION_ID)!.trackItems = true
    expect(await ids($)).toEqual(['intro', 'agent-brief:items', 'agent-brief:outputs'])

    app.isUp = false
    expect(await ids($), 'the GET fails').toEqual(['intro', 'agent-brief:items', 'agent-brief:outputs'])
    await clock.advance(10_000)
    expect(await ids($), 'the loop knows the app is down').toEqual(['intro', 'agent-brief:items', 'agent-brief:outputs'])
  })

  test('adds nothing and asks nothing when the app is down from the start', async ($, on) => {
    const { app, clock, start } = await setupCompanion($, on)
    app.isUp = false
    await start()
    await clock.settle()
    expect(await ids($)).toEqual(['intro', 'agent-brief:outputs'])
    expect(app.to('GET', `/sessions/${SESSION_ID}`)).toEqual([])
  })

  test('adds nothing when the app is too old to track', async ($, on) => {
    const { app, clock, start } = await setupCompanion($, on)
    app.isPreTrackingApp = true
    await start()
    await clock.settle()
    expect(await ids($)).toEqual(['intro', 'agent-brief:outputs'])
  })

  test('/track on, /track off and a bare /track send the right PATCH', async ($, on) => {
    const { app, world, clock, start } = await setupCompanion($, on)
    await start()
    await clock.settle()
    expect(world.commands).toContain('track')
    const patches = () => app.to('PATCH', `/sessions/${SESSION_ID}`).map(c => c.body)

    expect(await $.command.run(command('track', 'on'))).toEqual({
      text: `Item tracking on. Claude keeps items in .feedback/items/${SESSION_ID}.md and you answer them in the panel.`,
    })
    expect(app.sessions.get(SESSION_ID)!.trackItems).toBe(true)
    expect(await $.command.run(command('track', ' OFF '))).toEqual({ text: 'Item tracking off.' })
    expect(await $.command.run(command('track'))).toMatchObject({ text: expect.stringContaining('Item tracking on.') })
    expect(await $.command.run(command('track'))).toEqual({ text: 'Item tracking off.' })
    expect(patches()).toEqual([{ trackItems: true }, { trackItems: false }, { trackItems: true }, { trackItems: false }])
  })

  test('/track updates the cached state the prompt falls back to', async ($, on) => {
    const { app, clock, start } = await setupCompanion($, on)
    await start()
    await clock.settle()
    await $.command.run(command('track', 'on'))
    app.isUp = false
    expect((await itemsText($))?.text).toContain(ITEMS)
  })

  test('/track with the app down says so, and neither launches nor patches', async ($, on) => {
    const { app, world, clock, start } = await setupCompanion($, on)
    app.isUp = false
    await start()
    await clock.settle()
    expect(await $.command.run(command('track', 'on'))).toEqual({
      text: 'Agent Brief is not running. Start it, then run /track again.',
    })
    expect(app.to('PATCH', `/sessions/${SESSION_ID}`)).toEqual([])
    expect(world.runs.filter(r => r.argv[0] === 'sh'), 'no launch').toEqual([])
  })

  test('/track names the update when the app is too old, and rejects other words', async ($, on) => {
    const { app, clock, start } = await setupCompanion($, on)
    app.isPreTrackingApp = true
    await start()
    await clock.settle()
    expect(await $.command.run(command('track', 'on'))).toEqual({
      text: 'This Agent Brief cannot track items. Update to 0.2.6 or newer.',
    })
    expect(await $.command.run(command('track', 'maybe'))).toEqual({ text: 'Use /track, /track on or /track off.' })
    expect(app.to('PATCH', `/sessions/${SESSION_ID}`)).toHaveLength(1)
  })

  const pane = async ($: Parameters<TestBody>[0]) => JSON.stringify(await $.ui.render(briefPane()))

  test('the Brief pane\'s Track button toggles tracking, which turns the items section on and off', async ($, on) => {
    const { app, world, clock, start } = await setupCompanion($, on)
    await start()
    await clock.settle()
    await $.ui.render(briefPane())
    await $.ui.press({ plugin: 'agent-brief', key: 'brief-track' })
    await clock.settle()
    expect(app.sessions.get(SESSION_ID)!.trackItems).toBe(true)
    expect(world.toasts.at(-1)).toContain('Item tracking on.')
    expect(await pane($)).toContain('"label":"☑ Track"')
    expect(await ids($)).toEqual(['intro', 'agent-brief:items', 'agent-brief:outputs'])

    await $.ui.press({ plugin: 'agent-brief', key: 'brief-track' })
    await clock.settle()
    expect(world.toasts.at(-1)).toBe('Item tracking off.')
    expect(await pane($)).toContain('"label":"☐ Track"')
    expect(await ids($)).toEqual(['intro', 'agent-brief:outputs'])
  })

  test('the Brief pane\'s Track button follows a change made in the panel', async ($, on) => {
    const { app, clock, start } = await setupCompanion($, on)
    await start()
    await clock.settle()
    app.sessions.get(SESSION_ID)!.trackItems = true
    await ids($)
    expect(await pane($)).toContain('"label":"☑ Track"')
  })

  test('a Track press with the app down says so and stays off', async ($, on) => {
    const { app, world, clock, start } = await setupCompanion($, on)
    app.isUp = false
    await start()
    await clock.settle()
    await $.ui.render(briefPane())
    await $.ui.press({ plugin: 'agent-brief', key: 'brief-track' })
    await clock.settle()
    expect(world.toasts.at(-1)).toBe('Agent Brief is not running. Start it, then run /track again.')
    expect(await pane($)).toContain('"label":"☐ Track"')
  })
})
