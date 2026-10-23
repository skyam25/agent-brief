import type { RenderElement, RenderNode } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { SESSION_ID, fakeCompanion } from './companion-world'
import { BAND, COMPOSE, CWD, HOME, SESSION, command, worldOf } from './world'

type Dollar = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]

const MODE_FILE = '.claude/agent-brief.local.md'
const STYLE = { name: 'Explanatory', isKeepingCodingInstructions: true }

/** Seats the world, the clock, the fake app and an engine beneath the tool hooks. */
function setup($: Dollar, on: On, files: Record<string, string> = {}, cwd = CWD) {
  const world = worldOf(on, files, cwd)
  const clock = mock.clock(on)
  mock.store(on)
  const app = fakeCompanion(on, clock)
  on('tool.check', () => ({ decision: 'allow' as const }))
  on('tool.call', () => ({ result: 'ran' }))
  return { world, clock, app, start: () => $.session.start(SESSION) }
}

const modeOf = async ($: Dollar) => ((await $.command.run(command('mode'))) as { text: string }).text

const sections = async ($: Dollar, outputStyle: typeof STYLE | null = null) =>
  (await $.prompt.compose({ ...COMPOSE, outputStyle })).sections

const modeSection = async ($: Dollar, outputStyle: typeof STYLE | null = null) =>
  (await sections($, outputStyle)).find(s => s.id === 'agent-brief:mode')

const check = ($: Dollar, tool: string, file_path: string, agentId?: string) =>
  $.tool.check({ tool, input: { file_path, notebook_path: file_path }, ...(agentId ? { agentId } : {}) } as never)

const edit = ($: Dollar, file_path: string) =>
  $.tool.call({ tool: 'Edit', file_path, old_string: 'a', new_string: 'b' } as never) as Promise<{ deny?: string; result?: unknown }>

const band = async ($: Dollar) => JSON.stringify(await $.ui.render(BAND))

/** The keys of the drawn Buttons marked primary. */
function primaryKeys(node: RenderNode | RenderElement | null | undefined): string[] {
  if (node === null || node === undefined || typeof node !== 'object') return []
  const el = node as { type?: string; props?: { key?: string; variant?: string }; children?: readonly RenderNode[] }
  const own = el.type === 'Button' && el.props?.variant === 'primary' ? [el.props.key ?? ''] : []
  return [...own, ...(el.children ?? []).flatMap(child => primaryKeys(child))]
}

const press = async ($: Dollar, key: string) => {
  await $.ui.render(BAND)
  await $.ui.press({ plugin: 'agent-brief', key })
}

describe('resolution at session start', () => {
  test('no folder file means default', async ($, on) => {
    const { world, clock, start } = setup($, on)
    await start()
    await clock.settle()
    expect(world.commands).toContain('mode')
    expect(await modeOf($)).toContain('Mode: Default.')
  })

  test('a file in the cwd sets the mode', async ($, on) => {
    const { clock, start } = setup($, on, { [`${CWD}/${MODE_FILE}`]: '---\nmode: product\n---\n' })
    await start()
    await clock.settle()
    expect(await modeOf($)).toBe('Mode: Product. Switch with /mode default.')
  })

  test('a file in a parent folder is found, and the nearest wins', async ($, on) => {
    const files = {
      [`${HOME}/code/${MODE_FILE}`]: '---\nmode: prototype\nfidelity: wire\n---\n',
      [`${HOME}/${MODE_FILE}`]: '---\nmode: orchestrate\n---\n',
    }
    const { clock, start } = setup($, on, files, `${HOME}/code/app`)
    await start()
    await clock.settle()
    expect(await modeOf($)).toBe('Mode: Prototype at wireframe fidelity. Switch with /mode default.')
  })

  test('an invalid value is ignored', async ($, on) => {
    const { clock, start } = setup($, on, { [`${CWD}/${MODE_FILE}`]: '---\nmode: banana\n---\n' })
    await start()
    await clock.settle()
    expect(await modeOf($)).toContain('Mode: Default.')
  })

  test('a mode the session already holds outlives a restart of the hooks', async ($, on) => {
    const { clock, start } = setup($, on, { [`${CWD}/${MODE_FILE}`]: '---\nmode: product\n---\n' })
    await start()
    await clock.settle()
    await $.command.run(command('mode', 'orchestrate'))
    await start()
    await clock.settle()
    expect(await modeOf($)).toContain('Mode: Orchestrate.')
  })
})

describe('/mode', () => {
  test('sets a mode and says the next turn re-reads the conversation', async ($, on) => {
    const { clock, start } = setup($, on)
    await start()
    await clock.settle()
    expect(await $.command.run(command('mode', 'product'))).toEqual({
      text: 'Mode: Product. Source edits ask first; documents write freely. The next turn re-reads the conversation.',
    })
    expect(await $.command.run(command('mode', 'prototype html'))).toMatchObject({
      text: expect.stringMatching(/^Mode: Prototype at styled-HTML fidelity\./),
    })
    expect(await modeOf($)).toBe('Mode: Prototype at styled-HTML fidelity. Switch with /mode default.')
  })

  test('setting the mode it already has leaves out the re-read note', async ($, on) => {
    const { clock, start } = setup($, on)
    await start()
    await clock.settle()
    const out = (await $.command.run(command('mode', 'default'))) as { text: string }
    expect(out.text).toContain('Mode: Default.')
    expect(out.text).not.toContain('re-reads')
  })

  test('prototype without a fidelity, or an unknown word, prints usage', async ($, on) => {
    const { clock, start } = setup($, on)
    await start()
    await clock.settle()
    for (const args of ['prototype', 'sideways']) {
      const out = (await $.command.run(command('mode', args))) as { text: string }
      expect(out.text, args).toContain('Use /mode')
      expect(out.text).toContain('wireframe (wire)')
    }
    expect(await modeOf($)).toContain('Mode: Default.')
  })
})

describe('the system prompt', () => {
  test('default adds no mode section', async ($, on) => {
    const { clock, start } = setup($, on)
    await start()
    await clock.settle()
    expect((await sections($)).map(s => s.id)).toEqual(['intro', 'agent-brief:outputs'])
    expect((await sections($, STYLE)).map(s => s.id)).toEqual(['intro', 'agent-brief:outputs'])
  })

  test('product keeps its section after the cache boundary with any output style', async ($, on) => {
    const { clock, start } = setup($, on)
    await start()
    await clock.settle()
    await $.command.run(command('mode', 'product'))
    const section = await modeSection($)
    expect(section?.scope).toBe('session')
    expect(section?.text).toContain('Product mode is on for this session.')
    expect(await modeSection($), 'the same text every time').toEqual(section)
    expect(await modeSection($, STYLE)).toEqual(section)
    expect(await modeSection($, { ...STYLE, isKeepingCodingInstructions: false })).toEqual(section)
  })

  test('orchestrate keeps delegation instructions under an output style', async ($, on) => {
    const { clock, start } = setup($, on)
    await start()
    await clock.settle()
    await $.command.run(command('mode', 'orchestrate'))
    expect((await modeSection($))?.text).toContain('Orchestrate mode is on')
    expect(await modeSection($, STYLE)).toEqual(await modeSection($))
  })

  test('prototype keeps its posture and fidelity under an output style', async ($, on) => {
    const { clock, start } = setup($, on)
    await start()
    await clock.settle()
    await $.command.run(command('mode', 'prototype live'))
    expect((await modeSection($))?.text).toContain('Prototype mode is on')
    const styled = (await modeSection($, STYLE))?.text
    expect(styled).toContain('Default to live patch:')
    expect(styled).toEqual((await modeSection($))?.text)
  })

  test('the mode section follows the items section', async ($, on) => {
    const { app, clock, start } = setup($, on)
    await start()
    await clock.settle()
    app.sessions.get(SESSION_ID)!.trackItems = true
    await $.command.run(command('mode', 'product'))
    expect((await sections($)).map(s => s.id)).toEqual(['intro', 'agent-brief:items', 'agent-brief:mode', 'agent-brief:outputs'])
  })
})

describe('edit guard', () => {
  test('product asks before a source edit in either loop and lets reads and documents through', async ($, on) => {
    const { clock, start } = setup($, on)
    await start()
    await clock.settle()
    await $.command.run(command('mode', 'product'))
    for (const agentId of [undefined, 'investigator']) {
      for (const tool of ['Read', 'Grep', 'Glob', 'Agent']) {
        expect(await check($, tool, `${CWD}/src/app.ts`, agentId), tool).toEqual({ decision: 'allow' })
      }
      for (const tool of ['Edit', 'Write', 'NotebookEdit']) {
        // The host may also attribute an ask to the plugin that supplied it.
        expect(await check($, tool, `${CWD}/src/app.ts`, agentId), tool).toEqual(expect.objectContaining({
          decision: 'ask',
          reason: 'Product mode: this edits app.ts, which is source, not a document.',
        }))
      }
    }
    expect(await check($, 'Edit', `${CWD}/docs/spec.md`)).toEqual({ decision: 'allow' })
    expect(await check($, 'Write', `${CWD}/.feedback/items/s1.md`)).toEqual({ decision: 'allow' })
    // Product asks through tool.check; the host decides whether to grant it.
    // Unlike orchestrate, the plugin adds no unconditional tool.call denial.
    expect((await edit($, `${CWD}/src/app.ts`)).deny).toBeUndefined()
  })

  test('product leaves a deny from beneath alone', async ($, on) => {
    on('tool.check', { tool: 'Write' }, () => ({ decision: 'deny' as const, reason: 'a rule' }))
    const { clock, start } = setup($, on)
    await start()
    await clock.settle()
    await $.command.run(command('mode', 'product'))
    expect(await check($, 'Write', `${CWD}/src/app.ts`)).toEqual({ decision: 'deny', reason: 'a rule' })
  })

  test('default lets every edit through', async ($, on) => {
    const { clock, start } = setup($, on)
    await start()
    await clock.settle()
    expect(await check($, 'Edit', `${CWD}/src/app.ts`)).toEqual({ decision: 'allow' })
    expect(await edit($, `${CWD}/src/app.ts`)).toEqual({ result: 'ran' })
  })

  test('orchestrate refuses every main-loop edit and lets a subagent edit', async ($, on) => {
    const { clock, start } = setup($, on)
    await start()
    await clock.settle()
    await $.command.run(command('mode', 'orchestrate'))
    expect(await check($, 'Edit', `${CWD}/docs/spec.md`)).toEqual({
      decision: 'deny',
      reason: 'Orchestrate mode is on. Switch with /mode default to edit files.',
    })
    expect(await edit($, `${CWD}/docs/spec.md`)).toEqual({
      deny: 'Orchestrate mode is on. Switch with /mode default to edit files.',
    })
    expect(await check($, 'Edit', `${CWD}/src/app.ts`, 'builder')).toEqual({ decision: 'allow' })
  })

  test('prototype guards nothing', async ($, on) => {
    const { clock, start } = setup($, on)
    await start()
    await clock.settle()
    await $.command.run(command('mode', 'prototype wire'))
    expect(await check($, 'Edit', `${CWD}/src/app.ts`)).toEqual({ decision: 'allow' })
    expect(await edit($, `${CWD}/src/app.ts`)).toEqual({ result: 'ran' })
  })
})

describe('the Mode button above the prompt', () => {
  test('opens the mode picker, and Cancel closes it', async ($, on) => {
    const { world, clock, start } = setup($, on)
    await start()
    await clock.settle()
    await press($, 'mode')
    const picker = await band($)
    for (const label of ['Default', 'Product', 'Prototype', 'Orchestrate', 'Cancel']) {
      expect(picker, label).toContain(`"label":"${label}"`)
    }
    expect(picker).not.toContain('"label":"✎ Sketch"')

    await press($, 'mode-cancel')
    expect(await band($)).toContain('"label":"◇ Mode"')
    expect(world.toasts).toEqual([])
  })

  test('picking a mode applies it, toasts, and closes the picker', async ($, on) => {
    const { world, clock, start } = setup($, on)
    await start()
    await clock.settle()
    await press($, 'mode')
    await press($, 'mode-product')
    await clock.settle()
    expect(world.toasts.at(-1)).toBe(
      'Mode: Product. Source edits ask first; documents write freely. The next turn re-reads the conversation.',
    )
    expect(await band($)).toContain('"label":"◇ Product"')
    expect(await modeOf($)).toContain('Mode: Product.')
  })

  test('Prototype opens the fidelity row, Back returns, and a rung applies prototype', async ($, on) => {
    const { world, clock, start } = setup($, on)
    await start()
    await clock.settle()
    await press($, 'mode')
    await press($, 'mode-prototype')
    const rungs = await band($)
    for (const label of ['Wireframe', 'Styled HTML', 'Live patch', 'Freeze + patch', 'Interactive', 'Match existing', 'Back']) {
      expect(rungs, label).toContain(`"label":"${label}"`)
    }
    expect(world.toasts).toEqual([])

    await press($, 'fidelity-back')
    expect(await band($)).toContain('"label":"Orchestrate"')
    await press($, 'mode-prototype')
    await press($, 'fidelity-styled')
    await clock.settle()
    expect(world.toasts.at(-1)).toMatch(/^Mode: Prototype at styled-HTML fidelity\./)
    expect(await band($)).toContain('"label":"◇ Prototype · styled HTML"')
  })

  test('the current mode is marked in the picker', async ($, on) => {
    const { clock, start } = setup($, on)
    await start()
    await clock.settle()
    await $.command.run(command('mode', 'orchestrate'))
    await press($, 'mode')
    expect(primaryKeys(await $.ui.render(BAND))).toEqual(['mode-orchestrate'])
    await press($, 'mode-prototype')
    expect(primaryKeys(await $.ui.render(BAND)), 'no rung is current outside prototype').toEqual([])
  })
})

describe('mirroring to the app', () => {
  test('a change is sent to the app while it is up', async ($, on) => {
    const { app, clock, start } = setup($, on)
    await start()
    await clock.settle()
    expect(app.to('PATCH', `/sessions/${SESSION_ID}`), 'default sends nothing at start').toEqual([])

    await $.command.run(command('mode', 'prototype freeze'))
    await clock.settle()
    expect(app.to('PATCH', `/sessions/${SESSION_ID}`).map(c => c.body)).toEqual([{ mode: 'prototype', fidelity: 'freeze-patch' }])
    expect(app.sessions.get(SESSION_ID)).toMatchObject({ mode: 'prototype', fidelity: 'freeze-patch' })

    await $.command.run(command('mode', 'default'))
    await clock.settle()
    expect(app.to('PATCH', `/sessions/${SESSION_ID}`).at(-1)?.body).toEqual({ mode: 'default' })
  })

  test('a folder mode is sent once after the session registers', async ($, on) => {
    const { app, clock, start } = setup($, on, { [`${CWD}/${MODE_FILE}`]: '---\nmode: product\n---\n' })
    await start()
    await clock.settle()
    expect(app.to('PATCH', `/sessions/${SESSION_ID}`).map(c => c.body)).toEqual([{ mode: 'product' }])
    await clock.advance(60_000)
    expect(app.to('POST', '/sessions').length).toBeGreaterThan(1)
    expect(app.to('PATCH', `/sessions/${SESSION_ID}`), 'not again on re-registration').toHaveLength(1)
  })

  test('a change with the app down sends nothing and still applies', async ($, on) => {
    const { app, clock, start } = setup($, on)
    app.isUp = false
    await start()
    await clock.settle()
    await $.command.run(command('mode', 'product'))
    await clock.settle()
    expect(app.to('PATCH', `/sessions/${SESSION_ID}`)).toEqual([])
    expect(await modeOf($)).toContain('Mode: Product.')
  })
})
