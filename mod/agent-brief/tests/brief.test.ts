import { describe, expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { SESSION_ID, setupCompanion } from './companion-world'
import { BAND, CWD, briefPane, textOf } from './world'

type Dollar = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]

const ITEMS_PATH = `${CWD}/.feedback/items/${SESSION_ID}.md`
const OUTPUTS_PATH = `${CWD}/.feedback/outputs/${SESSION_ID}.json`

const ITEMS = [
  '# Items · checkout',
  '',
  '- [ ] #1 Row height',
  '      Claude: 44px rows with 12px gaps, or 40px with 8px?',
  '- [ ] #2 Header copy',
  '      Claude: What should the header say?',
  '- [ ] #3 Footer',
  '      Claude: I will move the links into the footer.',
  '- [x] #4 Pay button',
  '      Claude: done',
  '',
].join('\n')

const FEEDBACK_PATH = `${CWD}/checkout.html.feedback.md`
const FEEDBACK = [
  '# Feedback · checkout.html',
  '',
  '- [ ] #1 Filters',
  '    Claude: 2026-10-12 · cataloged',
  '- [x] #2 Pay',
  '    Claude: 2026-10-12 · done',
  '',
].join('\n')

const OUTPUTS = JSON.stringify({
  version: 1,
  sessionId: SESSION_ID,
  outputs: [
    { ref: 'docs/spec.md', title: 'Spec', kind: 'markdown', tier: 'declared', status: 'ready', declaredAt: 10 },
    { ref: 'deck.pdf', title: 'Deck', kind: 'pdf', tier: 'declared', status: 'drafting', declaredAt: 20 },
    { ref: 'mock.html', kind: 'html', tier: 'detected', writes: 1 },
  ],
})

/** Seats the world, the app and the pane hooks, then starts the session. */
async function setup($: Dollar, on: On, files: Record<string, string> = {}, messages: { role: 'user' | 'assistant'; text: string }[] = []) {
  const seated = await setupCompanion($, on)
  for (const [path, text] of Object.entries(files)) seated.world.files.set(path, text)
  const panes = new Set<string>()
  on('ui.panes', () => ({ value: [...panes].map(id => ({ id, title: 'Brief', isShown: true, isFocused: false, isPlaced: true })) }))
  on('ui.open', ($, e) => {
    panes.add(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', ($, e) => {
    panes.delete(e.id)
    return { value: undefined }
  })
  on('session.messages', () => ({ value: messages.map(m => ({ ...m, toolUses: [] })) }))
  on('tool.call', { tool: 'Write' }, ($, e) => {
    seated.world.files.set(e.file_path, e.content)
    return { result: 'written' } as never
  })
  await seated.start()
  await seated.clock.settle()
  return { ...seated, panes }
}

/** A prompt the user typed and sent. */
const typed = (text: string) => ({ text, wait: false, origin: { kind: 'composer' as const } })

const band = async ($: Dollar) => JSON.stringify(await $.ui.render(BAND))
const pane = async ($: Dollar, placement: 'dock' | 'inline' = 'dock') => JSON.stringify(await $.ui.render(briefPane(placement)))
const press = async ($: Dollar, key: string) => {
  await $.ui.render(briefPane())
  await $.ui.press({ plugin: 'agent-brief', key })
}

describe('the band', () => {
  test('shows Mode until the first prompt, then only Brief', async ($, on) => {
    await setup($, on)
    expect(await band($)).toContain('"label":"◇ Mode"')
    expect(await band($)).toContain('"label":"▣ Brief"')
    await $.prompt.submit(typed('plan the checkout'))
    expect(await band($)).not.toContain('◇ Mode')
    expect(await band($)).toContain('"label":"▣ Brief"')
  })

  test('a resumed session starts without the Mode button', async ($, on) => {
    await setup($, on, {}, [{ role: 'user', text: 'plan it' }])
    expect(await band($)).not.toContain('◇ Mode')
  })

  test('the Brief button counts Ready outputs and waiting items, and names the mode', async ($, on) => {
    await setup($, on, { [ITEMS_PATH]: ITEMS, [OUTPUTS_PATH]: OUTPUTS })
    expect(await band($)).toContain('"label":"▣ Brief 4"')
    await $.ui.render(BAND)
    await $.ui.press({ plugin: 'agent-brief', key: 'mode' })
    await $.ui.render(BAND)
    await $.ui.press({ plugin: 'agent-brief', key: 'mode-product' })
    expect(await band($)).toContain('"label":"▣ Brief 4 · Product"')
  })

  test('Brief opens the pane and closes it again', async ($, on) => {
    const { panes } = await setup($, on)
    await $.ui.render(BAND)
    await $.ui.press({ plugin: 'agent-brief', key: 'brief' })
    expect([...panes]).toEqual(['brief'])
    await $.ui.render(BAND)
    await $.ui.press({ plugin: 'agent-brief', key: 'brief' })
    expect([...panes]).toEqual([])
  })

  test('the session never opens the pane unasked', async ($, on) => {
    const { panes, clock } = await setup($, on, { [ITEMS_PATH]: ITEMS, [OUTPUTS_PATH]: OUTPUTS })
    await $.prompt.submit(typed('go'))
    await clock.settle()
    expect([...panes]).toEqual([])
  })
})

describe('the pane\'s outputs', () => {
  test('lists declared outputs and folds touched ones', async ($, on) => {
    await setup($, on, { [OUTPUTS_PATH]: OUTPUTS })
    const drawn = await pane($)
    expect(drawn).toContain(`Brief · work`)
    expect(drawn).toContain('"Spec"')
    expect(drawn).toContain('"Deck"')
    expect(drawn).toContain('"label":"▸ Touched (1)"')
    expect(drawn).not.toContain('mock.html')
    await press($, 'brief-touched')
    expect(await pane($)).toContain('mock.html')
  })

  test('offers In Agent Brief for Markdown and HTML only', async ($, on) => {
    await setup($, on, { [OUTPUTS_PATH]: OUTPUTS })
    await press($, 'brief-touched')
    const drawn = await pane($)
    expect(drawn).toContain('"key":"output-app-docs/spec.md"')
    expect(drawn).toContain('"key":"output-app-mock.html"')
    expect(drawn).not.toContain('"key":"output-app-deck.pdf"')
    expect(drawn).toContain('"key":"output-open-deck.pdf"')
  })

  test('Open hands the file\'s absolute path to open', async ($, on) => {
    const { world } = await setup($, on, { [OUTPUTS_PATH]: OUTPUTS })
    await press($, 'output-open-docs/spec.md')
    expect(world.runs.at(-1)!.argv).toEqual(['open', `${CWD}/docs/spec.md`])
  })

  test('In Agent Brief asks the app to open the output', async ($, on) => {
    const { app, world } = await setup($, on, { [OUTPUTS_PATH]: OUTPUTS })
    await press($, 'output-app-docs/spec.md')
    expect(app.to('POST', '/open').at(-1)!.body).toEqual({ sessionId: SESSION_ID, output: { path: 'docs/spec.md' } })
    expect(world.toasts).toEqual([])
  })

  test('an output with open feedback says so, and In Agent Brief opens its Feedback tab', async ($, on) => {
    const outputs = JSON.stringify({
      version: 1,
      sessionId: SESSION_ID,
      outputs: [
        { ref: 'checkout.html', title: 'Checkout', kind: 'html', tier: 'declared', status: 'ready', declaredAt: 30 },
        { ref: 'docs/spec.md', title: 'Spec', kind: 'markdown', tier: 'declared', status: 'ready', declaredAt: 10 },
      ],
    })
    on('turn.complete', () => ({ text: '' }))
    const { app, world } = await setup($, on, { [OUTPUTS_PATH]: outputs, [FEEDBACK_PATH]: FEEDBACK })
    const drawn = await pane($)
    expect(drawn).toContain('Feedback · 1 open')
    await press($, 'output-app-checkout.html')
    expect(app.to('POST', '/open').at(-1)!.body).toEqual({ sessionId: SESSION_ID, output: { path: 'checkout.html', tab: 'feedback' } })
    await press($, 'output-app-docs/spec.md')
    expect(app.to('POST', '/open').at(-1)!.body).toEqual({ sessionId: SESSION_ID, output: { path: 'docs/spec.md' } })

    // Claude's writes during a turn show once it ends.
    world.files.set(FEEDBACK_PATH, `${FEEDBACK}- [ ] #3 Another\n`)
    await $.turn.complete({ answer: 'Cataloged.', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer' })
    expect(await pane($)).toContain('Feedback · 2 open')
  })

  test('an app that opens the board instead asks to be updated', async ($, on) => {
    const { app, world } = await setup($, on, { [OUTPUTS_PATH]: OUTPUTS })
    app.isPreOutputsApp = true
    await press($, 'output-app-docs/spec.md')
    expect(world.toasts.at(-1)).toContain('Update Agent Brief')
  })

  test('a refusal from the app shows its reason', async ($, on) => {
    const { app, world } = await setup($, on, { [OUTPUTS_PATH]: OUTPUTS })
    app.outputRefusal = 'docs/spec.md is outside the session folder'
    await press($, 'output-app-docs/spec.md')
    expect(world.toasts.at(-1)).toBe('docs/spec.md is outside the session folder')
  })

  test('a declared output shows without reopening the pane', async ($, on) => {
    await setup($, on)
    expect(await pane($)).toContain('No outputs yet.')
    await $.tool.call({ tool: 'mcp__agent-brief__declare_output', title: 'Plan', path: 'plan.md', status: 'ready' } as never)
    expect(await pane($)).toContain('"Plan"')
  })
})

describe('the pane\'s items', () => {
  test('draws a control from each item\'s latest Claude line', async ($, on) => {
    await setup($, on, { [ITEMS_PATH]: ITEMS })
    const drawn = await pane($)
    expect(drawn).toContain('"label":"44px rows with 12px gaps"')
    expect(drawn).toContain('"label":"40px with 8px"')
    expect(drawn).toContain('"key":"item-2-answer"')
    expect(drawn).toContain('"key":"item-3-agree"')
    expect(drawn).toContain('"key":"item-3-answer"')
    expect(drawn).toContain('"label":"▸ Done (1)"')
  })

  test('Send answers writes You lines and submits the decisions message', async ($, on) => {
    const { world } = await setup($, on, { [ITEMS_PATH]: ITEMS })
    await press($, 'item-1-option-0')
    await $.ui.render(briefPane())
    await $.ui.input({ plugin: 'agent-brief', key: 'item-2-answer', text: 'Checkout' })
    await press($, 'item-3-agree')
    expect(await pane($)).toContain('"label":"Send answers (3)"')
    await press($, 'brief-send')

    const text = world.files.get(ITEMS_PATH)!
    expect(text).toContain('      Claude: 44px rows with 12px gaps, or 40px with 8px?\n      You: 44px rows with 12px gaps\n')
    expect(text).toContain('      You: Checkout\n')
    expect(text).toContain('      You: Agreed\n')
    expect(world.submitted.at(-1)).toBe(
      [
        `Decisions on 3 items in .feedback/items/${SESSION_ID}.md:`,
        '#1 Row height: 44px rows with 12px gaps',
        '#2 Header copy: Checkout',
        '#3 Footer: Agreed',
      ].join('\n'),
    )
    const after = await pane($)
    expect(after).toContain('"label":"Send answers"')
    expect(after).not.toContain('"key":"item-1-option-0"')
  })

  test('Send drops the answer to an item answered elsewhere since, and keeps the rest', async ($, on) => {
    const { world } = await setup($, on, { [ITEMS_PATH]: ITEMS })
    await press($, 'item-1-option-1')
    await press($, 'item-3-agree')
    world.files.set(ITEMS_PATH, ITEMS.replace('into the footer.\n', 'into the footer.\n      You: no, keep them\n'))
    await press($, 'brief-send')
    const text = world.files.get(ITEMS_PATH)!
    expect(text).toContain('      You: no, keep them\n- [x]')
    expect(text).not.toContain('You: Agreed')
    expect(world.submitted.at(-1)).toBe(`Decisions on an item in .feedback/items/${SESSION_ID}.md:\n#1 Row height: 40px with 8px`)
    expect(world.toasts.at(-1)).toContain('#3')
  })

  test('Clear drops a held answer', async ($, on) => {
    await setup($, on, { [ITEMS_PATH]: ITEMS })
    await press($, 'item-3-agree')
    expect(await pane($)).toContain('→ ')
    await press($, 'item-3-clear')
    expect(await pane($)).not.toContain('→ ')
  })

  test('Send with nothing held says so and submits nothing', async ($, on) => {
    const { world } = await setup($, on, { [ITEMS_PATH]: ITEMS })
    await press($, 'brief-send')
    expect(world.submitted).toEqual([])
    expect(world.toasts.at(-1)).toBe('Answer an item first, then Send answers.')
  })

  test('a Write to the items file redraws the pane', async ($, on) => {
    await setup($, on)
    expect(await pane($)).toContain('Track is off.')
    await $.tool.call({ tool: 'Write', file_path: ITEMS_PATH, content: ITEMS } as never)
    expect(await pane($)).toContain('Row height')
  })
})

describe('the pane\'s Mode Select', () => {
  test('applies a mode as /mode does and mirrors it to the app', async ($, on) => {
    const { app } = await setup($, on)
    await $.ui.render(briefPane())
    await $.ui.select({ plugin: 'agent-brief', key: 'brief-mode', value: 'product' })
    expect(app.sessions.get(SESSION_ID)!.mode).toBe('product')
    expect(await pane($)).toContain('"value":"product"')
  })

  test('Prototype waits for a fidelity before it applies', async ($, on) => {
    const { app } = await setup($, on)
    await $.ui.render(briefPane())
    await $.ui.select({ plugin: 'agent-brief', key: 'brief-mode', value: 'prototype' })
    expect(app.sessions.get(SESSION_ID)!.mode).toBeUndefined()
    expect(await pane($)).toContain('"key":"brief-fidelity"')
    await $.ui.select({ plugin: 'agent-brief', key: 'brief-fidelity', value: 'wireframe' })
    expect(app.sessions.get(SESSION_ID)).toMatchObject({ mode: 'prototype', fidelity: 'wireframe' })
  })
})

describe('the inline seat', () => {
  test('draws one summary line and opens only the Ready outputs', async ($, on) => {
    await setup($, on, { [ITEMS_PATH]: ITEMS, [OUTPUTS_PATH]: OUTPUTS })
    const drawn = await $.ui.render(briefPane('inline'))
    expect(textOf(drawn)).toContain('▣ Brief · 1 ready · 1 drafting · 3 items waiting')
    const json = JSON.stringify(drawn)
    expect(json).toContain('"label":"Open Spec"')
    expect(json).not.toContain('Open Deck')
    expect(json).not.toContain('brief-send')
    expect(json).toContain('"label":"▸ Expand"')
  })

  test('Expand draws the full Brief inline, and Collapse returns to the summary', async ($, on) => {
    await setup($, on, { [ITEMS_PATH]: ITEMS, [OUTPUTS_PATH]: OUTPUTS })
    await $.ui.render(briefPane('inline'))
    await $.ui.press({ plugin: 'agent-brief', key: 'brief-expand' })
    const expanded = await pane($, 'inline')
    expect(expanded).toContain('"label":"▾ Collapse"')
    expect(expanded).toContain('brief-send')
    expect(expanded).toContain('"key":"brief-mode"')
    await $.ui.press({ plugin: 'agent-brief', key: 'brief-expand' })
    const collapsed = await pane($, 'inline')
    expect(collapsed).toContain('"label":"▸ Expand"')
    expect(collapsed).not.toContain('brief-send')
  })

  test('the docked pane draws no Expand', async ($, on) => {
    await setup($, on, { [ITEMS_PATH]: ITEMS, [OUTPUTS_PATH]: OUTPUTS })
    expect(await pane($)).not.toContain('brief-expand')
  })
})
