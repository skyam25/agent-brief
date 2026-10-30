import { describe, expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import {
  outputPaths,
  INITIATIVE_MARK,
  INITIATIVE_NOT_RUNNING,
  attachPrompt,
  draftPrompt,
  injectionText,
  isInitiativeCommand,
  parseInitiativeArgs,
  pickChoices,
  recentLine,
  shouldInject,
  snapshotOf,
  summariesOf,
  tokenOf,
} from '../hooks/initiative'
import { INITIATIVE_UNDERSTANDING_CAP } from '../hooks/companion-protocol'
import type { InitiativeSnapshot } from '../hooks/companion-protocol'
import { SESSION_ID, setupCompanion } from './companion-world'
import { BAND, CWD, briefPane, command } from './world'

type Dollar = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]

const PRICING: InitiativeSnapshot = {
  id: 'ini-pricing',
  title: 'Pricing',
  revision: 7,
  attachmentRevision: 2,
  understanding: 'Monthly-first pricing is the plan. Legal still reviews the trial terms.',
  decisions: ['2026-10-14 Monthly-first (B over A); supersedes 2026-09-30 annual-first.'],
  open: ['Legal review of trial terms'],
  folders: [
    { path: '~/PM/Product/05-projects/Pricing', role: 'working' },
    { path: '~/PM/Product/07-decisions', role: 'decisions' },
  ],
}

const RECENT_LINE =
  'Agent Brief · recent initiatives: Pricing, Onboarding, Checkout. If this work belongs to one, run agent-brief initiative attach <name> before you start, and say so in one line.'

describe('initiative logic', () => {
  test('the token joins attachment revision, id and revision', () => {
    expect(tokenOf(PRICING)).toBe('2:ini-pricing:7')
    expect(shouldInject('2:ini-pricing:7', undefined, false), 'never sent').toBe(true)
    expect(shouldInject('2:ini-pricing:7', '2:ini-pricing:7', false), 'unchanged').toBe(false)
    expect(shouldInject('2:ini-pricing:8', '2:ini-pricing:7', false), 'a new revision').toBe(true)
    expect(shouldInject('3:ini-pricing:7', '2:ini-pricing:7', false), 'attached again').toBe(true)
    expect(shouldInject('2:ini-pricing:7', '2:ini-pricing:7', true), 'after a compaction').toBe(true)
  })

  test('the injection sits between the markers and points at the skill', () => {
    const text = injectionText(PRICING)
    const rows = text.split('\n')
    expect(rows[0]).toBe(INITIATIVE_MARK)
    expect(rows.at(-1)).toBe(INITIATIVE_MARK)
    expect(text).toContain('attached to the initiative Pricing (id ini-pricing, revision 7)')
    expect(text).toContain('`agent-brief initiative update ini-pricing --file <json>` at revision 7')
    expect(text).toContain('## Understanding\nMonthly-first pricing is the plan.')
    expect(text).toContain('## Decisions\n- 2026-10-14 Monthly-first')
    expect(text).toContain('## Open\n- Legal review of trial terms')
    expect(text).toContain('## Folders\n- ~/PM/Product/05-projects/Pricing → working\n- ~/PM/Product/07-decisions → decisions')
  })

  test('the injection leaves out empty lists and caps Understanding', () => {
    const long = injectionText({ ...PRICING, understanding: 'x'.repeat(5000), decisions: [], open: [], folders: [] })
    expect(long).not.toContain('## Decisions')
    expect(long).not.toContain('## Folders')
    const understanding = long.split('## Understanding\n')[1]!.split('\n')[0]!
    expect(understanding).toHaveLength(INITIATIVE_UNDERSTANDING_CAP)
    expect(understanding.endsWith('…')).toBe(true)
    expect(injectionText({ ...PRICING, understanding: '' })).toContain('## Understanding\n(empty)')
    const row = 'Add-on PRD [PRD.md](<file:/w/PRD.md>)'
    expect(outputPaths([row, 'Deck [Q3](https://x.com/q3)', 'Two [a](<file:/w/A%20B.md>) [b](<file:/w/b.md>)'])).toEqual(['/w/PRD.md', '/w/A B.md', '/w/b.md'])
    expect(injectionText({ ...PRICING, outputs: [row] })).toContain(`## Outputs\n- ${row}`)
    expect(injectionText(PRICING)).not.toContain('## Outputs')
  })

  test('a cut Understanding tells Claude to read the full text before rewriting it', () => {
    const NOTE = 'Understanding below is cut short. Run `agent-brief initiative show ini-pricing` for the full text before you rewrite it.'
    const appCut = `${'x'.repeat(INITIATIVE_UNDERSTANDING_CAP - 1)}…`
    expect(injectionText({ ...PRICING, understanding: 'x'.repeat(5000) }), 'cut by the mod').toContain(NOTE)
    expect(injectionText({ ...PRICING, understanding: appCut }), 'cut by the app').toContain(NOTE)
    expect(injectionText({ ...PRICING, understanding: 'x'.repeat(INITIATIVE_UNDERSTANDING_CAP) }), 'at the cap').toContain(NOTE)
    expect(injectionText({ ...PRICING, understanding: 'x'.repeat(5000) }).split('\n')[3], 'beside the update line').toBe(NOTE)
    expect(injectionText(PRICING)).not.toContain('cut short')
  })

  test('the first-prompt line names up to three recent initiatives', () => {
    const titles = ['Pricing', 'Onboarding', 'Checkout', 'Search'].map(title => ({ title }))
    expect(recentLine(titles)).toBe(RECENT_LINE)
    expect(recentLine([{ title: 'Pricing' }])).toBe(
      'Agent Brief · recent initiatives: Pricing. If this work belongs to one, run agent-brief initiative attach <name> before you start, and say so in one line.',
    )
    expect(recentLine([])).toBeUndefined()
  })

  test('/initiative reads its five forms', () => {
    expect(parseInitiativeArgs('')).toEqual({ kind: 'draft' })
    expect(parseInitiativeArgs(' OFF ')).toEqual({ kind: 'off' })
    expect(parseInitiativeArgs('refresh')).toEqual({ kind: 'refresh' })
    expect(parseInitiativeArgs('discover')).toEqual({ kind: 'discover' })
    expect(parseInitiativeArgs('Pricing page ')).toEqual({ kind: 'attach', name: 'Pricing page' })
  })

  test('the prompts name the CLI calls and the session', () => {
    expect(attachPrompt('Pricing "v2"', 's1')).toContain('`agent-brief initiative attach "Pricing \\"v2\\"" --session s1`')
    const draft = draftPrompt({
      sessionId: 's1',
      cwd: '/work',
      outputs: [
        { ref: 'docs/prd.md', title: 'PRD', kind: 'markdown', tier: 'declared', status: 'ready' },
        { ref: 'deck.pdf', title: 'Deck', kind: 'pdf', tier: 'declared', status: 'drafting' },
        { ref: 'notes.md', kind: 'markdown', tier: 'detected' },
      ],
      recent: [{ id: 'a', title: 'Pricing', line: '' }],
    })
    expect(draft).toContain('Ready outputs, for the Working rows: PRD (docs/prd.md).')
    expect(draft).toContain('Recent initiatives: Pricing.')
    expect(draft).toContain('agent-brief initiative create "<title>" --folder <folder> --file <draft.json>')
    expect(draft).toContain('agent-brief initiative attach <id> --session s1')
  })

  test('answers parse defensively', () => {
    expect(snapshotOf(PRICING)).toEqual(PRICING)
    expect(snapshotOf(undefined)).toBeUndefined()
    expect(snapshotOf({ id: 'a', title: 'A' }), 'no revisions').toBeUndefined()
    expect(snapshotOf({ ...PRICING, folders: [{ path: '/x', role: 'attic' }, { path: '/y', role: 'sources' }] })?.folders).toEqual([
      { path: '/y', role: 'sources' },
    ])
    const summary = { id: 'a', title: 'A', line: 'One.', lastActiveAt: 't' }
    expect(summariesOf([summary, { id: 'b' }])).toEqual([summary])
    expect(summariesOf({ initiatives: [summary] })).toEqual([summary])
    expect(summariesOf('nope')).toEqual([])
  })

  test('the change row puts the attached one first, then the recent ones', () => {
    const attached = { id: 'b', title: 'B', revision: 1, attachmentRevision: 1 }
    const recent = ['a', 'b', 'c', 'd'].map(id => ({ id, title: id.toUpperCase(), line: '' }))
    expect(pickChoices(attached, recent).map(c => c.id)).toEqual(['b', 'a', 'c'])
    expect(pickChoices(attached, recent, 20).map(c => c.id)).toEqual(['b', 'a', 'c', 'd'])
    expect(pickChoices(null, recent.slice(0, 2)).map(c => c.id)).toEqual(['a', 'b'])
  })

  test('spots the initiative verbs in a shell command', () => {
    expect(isInitiativeCommand('agent-brief initiative attach Pricing')).toBe(true)
    expect(isInitiativeCommand('"/Applications/Agent Brief.app/Contents/Resources/bin/agent-brief" initiative detach')).toBe(true)
    expect(isInitiativeCommand('agent-brief read')).toBe(false)
    expect(isInitiativeCommand(undefined)).toBe(false)
  })
})

/** A prompt the user typed and sent. */
const typed = (text: string) => ({ text, wait: false, origin: { kind: 'composer' as const } })

/** Seats the app with three initiatives, Pricing first, then starts the session. */
async function setup($: Dollar, on: On) {
  const seated = await setupCompanion($, on)
  const { app } = seated
  const { attachmentRevision: _, ...pricing } = PRICING
  app.initiatives.set(pricing.id, pricing)
  app.initiatives.set('ini-onboarding', { ...pricing, id: 'ini-onboarding', title: 'Onboarding', revision: 3 })
  app.initiatives.set('ini-checkout', { ...pricing, id: 'ini-checkout', title: 'Checkout', revision: 1 })
  on('session.messages', () => ({ value: [] }))
  on('session.compact', () => ({ messages: [{ role: 'user' as const, text: 'Summary.', toolUses: [] }] }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  await seated.start()
  await seated.clock.settle()
  return seated
}

const attach = (app: Awaited<ReturnType<typeof setup>>['app'], id = 'ini-pricing') =>
  app.attachments.set(SESSION_ID, { id, attachmentRevision: (app.attachments.get(SESSION_ID)?.attachmentRevision ?? 0) + 1 })

const band = async ($: Dollar) => JSON.stringify(await $.ui.render(BAND))

describe('the submit hook', () => {
  test('the first prompt names the recent initiatives once, after the user\'s text', async ($, on) => {
    const { world } = await setup($, on)
    await $.prompt.submit(typed('plan the pricing page'))
    await $.prompt.submit(typed('and the FAQ'))
    expect(world.submitted).toEqual(['plan the pricing page', 'and the FAQ'])
    expect(world.contexts).toEqual([[RECENT_LINE], []])
  })

  test('a first prompt that beats the initiatives load leaves the line for the next typed prompt', async ($, on) => {
    const seated = await setupCompanion($, on)
    const { attachmentRevision: _, ...pricing } = PRICING
    seated.app.initiatives.set(pricing.id, pricing)
    on('session.messages', () => ({ value: [] }))
    await seated.start()
    await $.prompt.submit(typed('do X'))
    await seated.clock.settle()
    await $.prompt.submit(typed('then Y'))
    await $.prompt.submit(typed('and Z'))
    expect(seated.world.contexts).toEqual([
      [],
      ['Agent Brief · recent initiatives: Pricing. If this work belongs to one, run agent-brief initiative attach <name> before you start, and say so in one line.'],
      [],
    ])
  })

  test('a resumed session names no recent initiatives', async ($, on) => {
    const seated = await setupCompanion($, on)
    const { attachmentRevision: _, ...pricing } = PRICING
    seated.app.initiatives.set(pricing.id, pricing)
    on('session.messages', () => ({ value: [{ role: 'user' as const, text: 'earlier work', toolUses: [] }] }))
    await seated.start()
    await seated.clock.settle()
    await $.prompt.submit(typed('carry on'))
    expect(seated.world.contexts).toEqual([[]])
  })

  test('names nothing when the app knows no initiatives', async ($, on) => {
    const { world, clock, start } = await setupCompanion($, on)
    on('session.messages', () => ({ value: [] }))
    await start()
    await clock.settle()
    await $.prompt.submit(typed('hello'))
    expect(world.contexts).toEqual([[]])
  })

  test('carries the snapshot only when the token moves', async ($, on) => {
    const { world, app } = await setup($, on)
    attach(app)
    await $.prompt.submit(typed('one'))
    await $.prompt.submit(typed('two'))
    app.initiatives.get('ini-pricing')!.revision = 8
    await $.prompt.submit(typed('three'))
    attach(app)
    await $.prompt.submit(typed('four'))
    const sent = world.contexts.map(c => (c[0] ?? '').split('\n')[1] ?? '')
    expect(sent[0]).toContain('revision 7')
    expect(sent[1], 'unchanged token').toBe('')
    expect(sent[2]).toContain('revision 8')
    expect(sent[3], 'attached again').toContain('revision 8')
    expect(world.contexts[0]![0]!.startsWith(INITIATIVE_MARK)).toBe(true)
    expect(world.submitted).toEqual(['one', 'two', 'three', 'four'])
  })

  test('a compaction makes the next prompt carry the snapshot again', async ($, on) => {
    const { world, app } = await setup($, on)
    attach(app)
    await $.prompt.submit(typed('one'))
    await $.prompt.submit(typed('two'))
    await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'one', toolUses: [] }] })
    await $.prompt.submit(typed('three'))
    await $.prompt.submit(typed('four'))
    expect(world.contexts.map(c => c.length)).toEqual([1, 0, 1, 0])
  })

  test('a precompute leaves the snapshot in place, so the next prompt carries nothing', async ($, on) => {
    const { world, app } = await setup($, on)
    attach(app)
    await $.prompt.submit(typed('one'))
    await $.session.compact({ trigger: 'precompute', messages: [{ role: 'user', text: 'one', toolUses: [] }] })
    await $.prompt.submit(typed('two'))
    expect(world.contexts.map(c => c.length)).toEqual([1, 0])
  })

  test('a slash command carries nothing, and leaves the recent line for the next typed prompt', async ($, on) => {
    const { world, app } = await setup($, on)
    await $.prompt.submit({ ...typed('/review'), command: { name: 'review', args: '' } })
    await $.prompt.submit(typed('go'))
    attach(app)
    await $.prompt.submit({ ...typed('/review'), command: { name: 'review', args: '' } })
    expect(world.contexts).toEqual([[], [RECENT_LINE], []])
  })

  test('with the app down the prompt enters as typed', async ($, on) => {
    const { world, app, clock } = await setup($, on)
    attach(app)
    app.isUp = false
    await clock.advance(10_000)
    await $.prompt.submit(typed('still works'))
    expect(world.submitted).toEqual(['still works'])
    expect(world.contexts).toEqual([[]])
  })

  test('a detach since the last snapshot gets one note', async ($, on) => {
    const { world, app } = await setup($, on)
    attach(app)
    await $.prompt.submit(typed('one'))
    app.attachments.delete(SESSION_ID)
    await $.prompt.submit(typed('two'))
    await $.prompt.submit(typed('three'))
    expect(world.contexts[1]).toEqual(['This session is no longer attached to the Agent Brief initiative Pricing. Stop maintaining its brief.'])
    expect(world.contexts[2]).toEqual([])
  })
})

describe('/initiative', () => {
  test('a name hands Claude the attach call', async ($, on) => {
    const { world, clock } = await setup($, on)
    expect(await $.command.run(command('initiative', 'Pricing'))).toEqual({ text: 'Asking Claude to attach Pricing…' })
    await clock.settle()
    expect(world.submitted).toHaveLength(1)
    expect(world.submitted[0]).toContain(`agent-brief initiative attach "Pricing" --session ${SESSION_ID}`)
  })

  test('a bare /initiative hands Claude the draft with the Ready outputs and recent initiatives', async ($, on) => {
    const { world, clock } = await setup($, on)
    await $.command.run(command('initiative'))
    await clock.settle()
    expect(world.submitted[0]).toContain('Recent initiatives: Pricing, Onboarding, Checkout.')
    expect(world.submitted[0]).toContain(`agent-brief initiative attach <id> --session ${SESSION_ID}`)
  })

  test('discover works with the app down; writes say the app is needed', async ($, on) => {
    const { world, app, clock } = await setup($, on)
    app.isUp = false
    expect(await $.command.run(command('initiative', 'Pricing'))).toEqual({ text: INITIATIVE_NOT_RUNNING })
    expect(await $.command.run(command('initiative', 'off'))).toEqual({ text: INITIATIVE_NOT_RUNNING })
    expect(await $.command.run(command('initiative', 'discover'))).toEqual({ text: 'Asking Claude to survey this folder for initiatives…' })
    await clock.settle()
    expect(world.submitted).toHaveLength(1)
    expect(world.submitted[0]).toContain(`Run Discover from the initiative-brief skill over ${CWD}`)
  })

  test('refresh hands Claude the snapshot without a turn, and the next prompt does not repeat it', async ($, on) => {
    const { world, app } = await setup($, on)
    attach(app)
    const refreshed = await $.command.run(command('initiative', 'refresh'))
    expect(refreshed.text).toBe('Sent the Pricing brief to Claude (revision 7).')
    expect(refreshed.context?.[0]?.startsWith(INITIATIVE_MARK)).toBe(true)
    await $.prompt.submit(typed('go'))
    expect(world.contexts).toEqual([[]])
  })

  test('off detaches and tells Claude', async ($, on) => {
    const { app } = await setup($, on)
    attach(app)
    expect(await $.command.run(command('initiative', 'off'))).toEqual({
      text: 'Detached from Pricing. Agent Brief adds nothing more to your prompts.',
      context: ['This session is no longer attached to the Agent Brief initiative Pricing. Stop maintaining its brief.'],
    })
    expect(app.attachments.has(SESSION_ID)).toBe(false)
    expect(await $.command.run(command('initiative', 'off'))).toEqual({
      text: 'This session has no initiative. Run /initiative <name> to attach one.',
    })
  })
})

describe('the band and the pane', () => {
  test('the band reads ◆ <title> only while attached', async ($, on) => {
    const { app } = await setup($, on)
    expect(await band($)).not.toContain('◆')
    attach(app)
    await $.prompt.submit(typed('go'))
    expect(await band($)).toContain('◆ Pricing')
    expect(await band($)).toContain('"label":"◆ Pricing"')
  })

  test('change picks among the recent initiatives and attaches over the socket', async ($, on) => {
    const { app, world } = await setup($, on)
    attach(app)
    await $.prompt.submit(typed('go'))
    await $.ui.render(BAND)
    await $.ui.press({ plugin: 'agent-brief', key: 'initiative-change' })
    const row = await band($)
    expect(row).toContain('"label":"Pricing"')
    expect(row).toContain('"label":"Onboarding"')
    expect(row).toContain('"label":"Detach"')
    await $.ui.press({ plugin: 'agent-brief', key: 'initiative-ini-onboarding' })
    expect(app.to('PUT', `/sessions/${SESSION_ID}/initiative`).map(c => c.body)).toEqual([{ initiativeId: 'ini-onboarding' }])
    expect(world.toasts).toContain('Attached Onboarding. Claude gets its brief with your next prompt.')
    expect(await band($)).toContain('◆ Onboarding')
  })

  test('Detach in the change row detaches', async ($, on) => {
    const { app, world } = await setup($, on)
    attach(app)
    await $.prompt.submit(typed('go'))
    await $.ui.render(BAND)
    await $.ui.press({ plugin: 'agent-brief', key: 'initiative-change' })
    await $.ui.render(BAND)
    await $.ui.press({ plugin: 'agent-brief', key: 'initiative-detach' })
    expect(app.attachments.has(SESSION_ID)).toBe(false)
    expect(world.toasts).toContain('Detached from Pricing. Agent Brief adds nothing more to your prompts.')
    expect(await band($)).not.toContain('◆')
  })

  test('an attach Claude runs in Bash shows on the band at once', async ($, on) => {
    on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: 'Attached Pricing', stderr: '', interrupted: false } }) as never)
    const { app } = await setup($, on)
    attach(app)
    await $.tool.call({ tool: 'Bash', tool_use_id: 'b1', command: 'agent-brief initiative attach Pricing' } as never)
    expect(await band($)).toContain('◆ Pricing')
  })

  test('attach initiative shows on the band only while none is attached and there are some to pick', async ($, on) => {
    const { app } = await setup($, on)
    expect(await band($)).toContain('"label":"attach initiative"')
    attach(app)
    await $.prompt.submit(typed('go'))
    expect(await band($)).not.toContain('attach initiative')
  })

  test('attach initiative is absent when there are no initiatives', async ($, on) => {
    const seated = await setupCompanion($, on)
    on('session.messages', () => ({ value: [] }))
    on('ui.panes', () => ({ value: [] }))
    await seated.start()
    await seated.clock.settle()
    expect(await band($)).not.toContain('attach initiative')
  })

  test('attach initiative picks among the recent ones and attaches over the socket', async ($, on) => {
    const { app, world } = await setup($, on)
    await $.ui.render(BAND)
    await $.ui.press({ plugin: 'agent-brief', key: 'initiative-attach' })
    const row = await band($)
    expect(row).toContain('"label":"Pricing"')
    expect(row).toContain('"label":"Checkout"')
    expect(row).not.toContain('"label":"Detach"')
    await $.ui.press({ plugin: 'agent-brief', key: 'initiative-ini-checkout' })
    expect(app.to('PUT', `/sessions/${SESSION_ID}/initiative`).map(c => c.body)).toEqual([{ initiativeId: 'ini-checkout' }])
    expect(world.toasts).toContain('Attached Checkout. Claude gets its brief with your next prompt.')
    expect(await band($)).toContain('◆ Checkout')
  })

  test('the Brief pane\'s Initiative Select lists None and every initiative', async ($, on) => {
    const { app, clock } = await setup($, on)
    app.initiatives.set('ini-search', { ...app.initiatives.get('ini-pricing')!, id: 'ini-search', title: 'Search', revision: 2 })
    await $.ui.render(BAND)
    await $.ui.press({ plugin: 'agent-brief', key: 'brief' })
    await $.ui.render(briefPane())
    await clock.settle()
    const pane = JSON.stringify(await $.ui.render(briefPane()))
    expect(pane).toContain('"key":"brief-initiative"')
    for (const title of ['None', 'Pricing', 'Onboarding', 'Checkout', 'Search']) expect(pane).toContain(`"label":"${title}"`)
  })

  test('the Brief pane\'s first draw reads an attachment made elsewhere, even just after registration', async ($, on) => {
    const { app, clock } = await setup($, on)
    attach(app, 'ini-checkout')
    await $.ui.render(briefPane())
    await clock.settle()
    expect(JSON.stringify(await $.ui.render(briefPane()))).toContain('"value":"ini-checkout"')
  })

  test('a later draw reads again after 30 s', async ($, on) => {
    const { app, clock } = await setup($, on)
    await $.ui.render(briefPane())
    await clock.settle()
    attach(app, 'ini-onboarding')
    await $.ui.render(briefPane())
    await clock.settle()
    expect(JSON.stringify(await $.ui.render(briefPane())), 'fresh for 30 s').toContain('"value":""')
    await clock.advance(31_000)
    await $.ui.render(briefPane())
    await clock.settle()
    expect(JSON.stringify(await $.ui.render(briefPane()))).toContain('"value":"ini-onboarding"')
  })

  test('a refused pick leaves the Select on the attachment the app holds', async ($, on) => {
    const { app, world } = await setup($, on)
    attach(app)
    await $.prompt.submit(typed('go'))
    app.initiatives.delete('ini-onboarding')
    await $.ui.render(briefPane())
    await $.ui.select({ plugin: 'agent-brief', key: 'brief-initiative', value: 'ini-onboarding' })
    expect(world.toasts).toContain('Agent Brief did not attach that initiative.')
    const pane = JSON.stringify(await $.ui.render(briefPane()))
    expect(pane, 'a fresh key drops the refused pick').toContain('"key":"brief-initiative-1"')
    expect(pane).toContain('"value":"ini-pricing"')
  })

  test('the band picks among three, and the pane lists at most 20', async ($, on) => {
    const { app } = await setup($, on)
    const pricing = app.initiatives.get('ini-pricing')!
    for (let n = 0; n < 25; n++) app.initiatives.set(`ini-x${n}`, { ...pricing, id: `ini-x${n}`, title: `X${n}` })
    attach(app, 'ini-x24')
    await $.prompt.submit(typed('go'))
    await $.ui.render(BAND)
    await $.ui.press({ plugin: 'agent-brief', key: 'initiative-change' })
    const row = await band($)
    expect(row.match(/"key":"initiative-ini-/g)?.length).toBe(3)
    const pane = JSON.stringify(await $.ui.render(briefPane()))
    const options = JSON.parse(pane.match(/"key":"brief-initiative","options":(\[.*?\])/)![1]!) as { value: string }[]
    expect(options.length).toBe(21)
    expect(options[1]!.value).toBe('ini-x24')
  })

  test('picking in the Initiative Select attaches, and None detaches', async ($, on) => {
    const { app, world } = await setup($, on)
    await $.ui.render(briefPane())
    await $.ui.select({ plugin: 'agent-brief', key: 'brief-initiative', value: 'ini-onboarding' })
    expect(app.to('PUT', `/sessions/${SESSION_ID}/initiative`).map(c => c.body)).toEqual([{ initiativeId: 'ini-onboarding' }])
    const pane = JSON.stringify(await $.ui.render(briefPane()))
    expect(pane).toContain('"value":"ini-onboarding"')
    expect(pane).toContain('Initiative · revision 3')
    await $.ui.select({ plugin: 'agent-brief', key: 'brief-initiative', value: '' })
    expect(app.attachments.has(SESSION_ID)).toBe(false)
    expect(world.toasts).toContain('Detached from Onboarding. Agent Brief adds nothing more to your prompts.')
  })

  test('the Initiative line is text without fields', async ($, on) => {
    const { app } = await setup($, on)
    const mobile = { ...briefPane(), surface: 'mobile' as const }
    expect(JSON.stringify(await $.ui.render(mobile))).toContain('Initiative · none')
    attach(app)
    await $.prompt.submit(typed('go'))
    const pane = JSON.stringify(await $.ui.render(mobile))
    expect(pane).not.toContain('brief-initiative')
    expect(pane).toContain('Pricing')
    expect(pane).toContain(' · revision 7')
  })
})
