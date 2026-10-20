import { describe, expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import type { OutputsFile } from '../hooks/companion-protocol'
import { SESSION_ID, fakeCompanion } from './companion-world'
import { COMPOSE, CWD, SESSION, command, worldOf } from './world'

type Dollar = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]

const DECLARE = 'mcp__agent-brief__declare_output'
const OUTPUTS = `${CWD}/.feedback/outputs/${SESSION_ID}.json`

/** Seats the world, the clock, the fake app and an engine that runs every tool as 'ran'. */
function setup($: Dollar, on: On, files: Record<string, string> = {}) {
  const world = worldOf(on, files)
  const clock = mock.clock(on)
  mock.store(on)
  fakeCompanion(on, clock)
  on('tool.call', () => ({ result: 'ran' }))
  return { world, clock, start: () => $.session.start(SESSION) }
}

const declare = async ($: Dollar, input: Record<string, unknown>) =>
  String(((await $.tool.call({ tool: DECLARE, ...input } as never)) as { result?: unknown }).result)

const write = ($: Dollar, file_path: string, content: string) =>
  $.tool.call({ tool: 'Write', file_path, content } as never) as Promise<{ deny?: string; result?: unknown }>

const outputsOf = (world: { files: Map<string, string> }): OutputsFile | undefined => {
  const text = world.files.get(OUTPUTS)
  return text === undefined ? undefined : (JSON.parse(text) as OutputsFile)
}

describe('declare_output', () => {
  test('writes a declared record to the outputs file', async ($, on) => {
    const { world, start } = setup($, on)
    await start()
    const reply = await declare($, { title: 'Pricing strategy', path: 'docs/pricing.md' })
    expect(reply).toBe(
      'Declared "Pricing strategy" (docs/pricing.md, drafting). It shows in the Agent Brief panel.\n' +
        'To show it in Agent Brief, run: agent-brief open --output "/work/docs/pricing.md"',
    )
    expect(outputsOf(world)).toEqual({
      version: 1,
      sessionId: SESSION_ID,
      outputs: [
        {
          ref: 'docs/pricing.md',
          title: 'Pricing strategy',
          kind: 'markdown',
          tier: 'declared',
          status: 'drafting',
          declaredAt: expect.any(Number),
        },
      ],
    })
    expect(world.toasts).toEqual([])
  })

  test('a cd after start keeps the outputs file in the folder the session started in', async ($, on) => {
    const { world, start } = setup($, on)
    await start()
    world.cwd = `${CWD}/companion`
    await declare($, { title: 'Launch page', url: 'https://claude.ai/artifact/abc' })
    expect(outputsOf(world)?.outputs[0]).toMatchObject({ ref: 'https://claude.ai/artifact/abc' })
    expect([...world.files.keys()].some(k => k.startsWith(`${CWD}/companion/`))).toBe(false)
  })

  test('a session that starts after a cd keeps its outputs file at the project root', async ($, on) => {
    const { world, start } = setup($, on)
    world.cwd = `${CWD}/design`
    await start()
    await declare($, { title: 'Setup canvas', path: 'design/onboarding.html' })
    expect(outputsOf(world)?.outputs[0]).toMatchObject({ ref: 'design/onboarding.html' })
    expect([...world.files.keys()].some(k => k.startsWith(`${CWD}/design/`))).toBe(false)
  })

  test('an engine without session.root keeps the folder the session started in', async ($, on) => {
    const { world, start } = setup($, on)
    world.root = undefined
    await start()
    world.cwd = `${CWD}/companion`
    await declare($, { title: 'Launch page', url: 'https://claude.ai/artifact/abc' })
    expect(outputsOf(world)?.outputs[0]).toMatchObject({ ref: 'https://claude.ai/artifact/abc' })
  })

  test('declares a URL as an artifact', async ($, on) => {
    const { world, start } = setup($, on)
    await start()
    await declare($, { title: 'Launch page', url: 'https://claude.ai/artifact/abc', status: 'ready' })
    expect(outputsOf(world)?.outputs[0]).toMatchObject({
      ref: 'https://claude.ai/artifact/abc',
      url: 'https://claude.ai/artifact/abc',
      kind: 'artifact',
      status: 'ready',
    })
  })

  test('explains the usage for both or neither of path and url, and writes nothing', async ($, on) => {
    const { world, start } = setup($, on)
    await start()
    expect(await declare($, { title: 'A' })).toContain('exactly one of path or url')
    expect(await declare($, { title: 'A', path: 'a.md', url: 'https://x.y' })).toContain('exactly one of path or url')
    expect(world.files.has(OUTPUTS)).toBe(false)
  })

  test('a declare on a path the hook already saw flips its tier', async ($, on) => {
    const { world, start } = setup($, on)
    await start()
    await write($, `${CWD}/docs/plan.md`, '# Plan\n')
    await declare($, { title: 'Plan', path: 'docs/plan.md', status: 'ready' })
    const outputs = outputsOf(world)?.outputs
    expect(outputs).toHaveLength(1)
    expect(outputs?.[0]).toMatchObject({ ref: 'docs/plan.md', tier: 'declared', status: 'ready', origin: 'created', writes: 1 })
  })
})

describe('the write hook', () => {
  test('a Write of a document records a created record, and a second Write bumps it', async ($, on) => {
    const { world, clock, start } = setup($, on)
    await start()
    expect(await write($, `${CWD}/docs/plan.md`, '# Plan\n')).toEqual({ result: 'ran' })
    expect(outputsOf(world)?.outputs).toEqual([
      {
        ref: 'docs/plan.md',
        kind: 'markdown',
        tier: 'detected',
        origin: 'created',
        firstWriteAt: expect.any(Number),
        lastWriteAt: expect.any(Number),
        writes: 1,
      },
    ])
    await clock.advance(1_000)
    await write($, `${CWD}/docs/plan.md`, '# Plan\n\nMore.\n')
    const record = outputsOf(world)?.outputs[0]
    expect(record).toMatchObject({ origin: 'created', writes: 2 })
    expect(record!.lastWriteAt! - record!.firstWriteAt!).toBe(1_000)
  })

  test('an Edit of a file that existed records it as edited', async ($, on) => {
    const { world, start } = setup($, on, { [`${CWD}/README.md`]: '# Readme\n' })
    await start()
    await $.tool.call({ tool: 'Edit', file_path: `${CWD}/README.md`, old_string: 'a', new_string: 'b' } as never)
    expect(outputsOf(world)?.outputs[0]).toMatchObject({ ref: 'README.md', origin: 'edited', writes: 1 })
  })

  test('a Write that replaces most of an existing file counts as created', async ($, on) => {
    const { world, start } = setup($, on, { [`${CWD}/docs/brief.md`]: 'stub' })
    await start()
    await write($, `${CWD}/docs/brief.md`, '# Brief\n\nA much longer body than the stub was.\n')
    expect(outputsOf(world)?.outputs[0]).toMatchObject({ origin: 'created' })
  })

  test('code, files under .feedback and files outside the project record nothing', async ($, on) => {
    const { world, start } = setup($, on)
    await start()
    expect(await write($, `${CWD}/src/app.ts`, 'export {}\n')).toEqual({ result: 'ran' })
    await write($, `${CWD}/.feedback/items/${SESSION_ID}.md`, '# Items\n')
    await write($, '/elsewhere/notes.md', '# Notes\n')
    expect(world.files.has(OUTPUTS)).toBe(false)
  })

  test('a denied write records nothing', async ($, on) => {
    const { world, start } = setup($, on)
    await start()
    await $.command.run(command('mode', 'orchestrate'))
    expect((await write($, `${CWD}/docs/plan.md`, '# Plan\n')).deny).toBeDefined()
    expect(world.files.has(OUTPUTS)).toBe(false)
  })

  test('a subagent write counts too', async ($, on) => {
    const { world, start } = setup($, on)
    await start()
    await $.tool.call({ tool: 'Write', file_path: `${CWD}/docs/a.md`, content: '# A\n', agentId: 'agent-1' } as never)
    expect(outputsOf(world)?.outputs.map(o => o.ref)).toEqual(['docs/a.md'])
  })

  test('concurrent writes keep every record', async ($, on) => {
    const { world, start } = setup($, on)
    await start()
    await Promise.all([
      write($, `${CWD}/docs/a.md`, '# A\n'),
      write($, `${CWD}/docs/b.md`, '# B\n'),
      declare($, { title: 'C', path: 'docs/c.md' }),
    ])
    expect(outputsOf(world)?.outputs.map(o => o.ref).sort()).toEqual(['docs/a.md', 'docs/b.md', 'docs/c.md'])
  })

  test('a failure to record never blocks the tool', async ($, on) => {
    const { world, start } = setup($, on)
    world.isWriteRefused = true
    await start()
    expect(await write($, `${CWD}/docs/plan.md`, '# Plan\n')).toEqual({ result: 'ran' })
  })
})

describe('/outputs and the prompt', () => {
  test('/outputs prints declared outputs, then touched documents', async ($, on) => {
    const { start } = setup($, on)
    await start()
    expect(await $.command.run(command('outputs'))).toEqual({ text: 'No outputs yet.' })
    await declare($, { title: 'Pricing strategy', path: 'docs/pricing.md' })
    await write($, `${CWD}/notes/scratch.md`, '# Scratch\n')
    expect(await $.command.run(command('outputs'))).toEqual({
      text: 'Declared\n• Pricing strategy — docs/pricing.md · drafting\n\nTouched\n• notes/scratch.md · created · 1 write',
    })
  })

  test('the outputs section is always in the system prompt', async ($, on) => {
    const { start } = setup($, on)
    await start()
    const section = (await $.prompt.compose(COMPOSE)).sections.find(s => s.id === 'agent-brief:outputs')
    expect(section?.scope).toBe('session')
    expect(section?.text).toContain('# Outputs (Agent Brief)')
    expect(section?.text).toContain('declare_output')
  })
})
