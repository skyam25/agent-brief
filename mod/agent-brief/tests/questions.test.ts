import { describe, expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { SESSION_ID, setupCompanion } from './companion-world'
import { BAND, COMPOSE, CWD, briefPane, command } from './world'

type Dollar = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]

const ASK = 'mcp__agent-brief__ask_questions'
const ITEMS_PATH = `${CWD}/.feedback/items/${SESSION_ID}.md`
const ITEMS = '- [ ] #1 Rows\n      Claude: Tight or loose?\n'

const QUESTIONS = [
  { id: 'audience', text: 'Who reads it?', kind: 'options', options: ['Engineers', 'Execs'] },
  { id: 'length', text: 'How long?', kind: 'select', options: ['One page', 'Two pages', 'Long'] },
  { id: 'goal', text: 'What should it decide?', kind: 'text' },
]

/**
 * Seats the world, the app and a pane host, then starts the session.
 * `isNarrow` makes the host refuse to place an unasked open, as a terminal under 144 columns does.
 */
async function setup($: Dollar, on: On, { isToolRefused = false, isPaneOpen = false, isNarrow = false } = {}) {
  const seated = await setupCompanion($, on)
  seated.world.isToolRefused = isToolRefused
  seated.world.files.set(ITEMS_PATH, ITEMS)
  const panes = new Set<string>(isPaneOpen ? ['brief'] : [])
  const opens: { id: string; focus?: true }[] = []
  on('ui.panes', () => ({ value: [...panes].map(id => ({ id, title: 'Brief', isShown: true, isFocused: false, isPlaced: true })) }))
  on('ui.open', ($, e) => {
    opens.push({ id: e.id, ...(e.focus ? { focus: e.focus } : {}) })
    if (isNarrow) return { value: { isPlaced: false, reason: 'below 144 columns at 117' } }
    panes.add(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', ($, e) => {
    panes.delete(e.id)
    return { value: undefined }
  })
  on('session.messages', () => ({ value: [] }))
  await seated.start()
  await seated.clock.settle()
  return { ...seated, panes, opens }
}

const ask = async ($: Dollar, questions: unknown = QUESTIONS) =>
  String(((await $.tool.call({ tool: ASK, questions } as never)) as { result?: unknown }).result)
const pane = async ($: Dollar, placement: 'dock' | 'inline' = 'dock') => JSON.stringify(await $.ui.render(briefPane(placement)))
const press = async ($: Dollar, key: string) => {
  await $.ui.render(briefPane())
  await $.ui.press({ plugin: 'agent-brief', key })
}
const sectionIds = async ($: Dollar, tools: string[] = []) => (await $.prompt.compose({ ...COMPOSE, tools })).sections.map(s => s.id)
const grillText = async ($: Dollar, tools: string[] = []) =>
  (await $.prompt.compose({ ...COMPOSE, tools })).sections.find(s => s.id === 'agent-brief:grill')?.text

describe('ask_questions', () => {
  test('opens the pane with the questions in it', async ($, on) => {
    const { world, panes } = await setup($, on)
    expect(await ask($)).toBe("Asked 3 questions in the Brief pane. The answers arrive as the user's next message.")
    expect([...panes]).toEqual(['brief'])
    expect(world.toasts).toEqual([])

    const drawn = await pane($)
    expect(drawn).toContain('Questions · from Claude · 3')
    expect(drawn).toContain('"key":"question-audience-option-0"')
    expect(drawn).toContain('"key":"question-length-select"')
    expect(drawn).toContain('"key":"question-goal-answer"')
    expect(drawn).toContain('"key":"questions-send"')
    expect(drawn.indexOf('Questions · from Claude')).toBeLessThan(drawn.indexOf('"key":"brief-track"'))
  })

  test('asks for the keyboard and starts the focus ring on the first unanswered option', async ($, on) => {
    const { opens } = await setup($, on)
    await ask($)
    expect(opens).toEqual([{ id: 'brief', focus: true }])
    const autoFocused = (await pane($)).match(/"key":"[^"]+"(?=[^{}]*"autoFocus":true)|"autoFocus":true[^{}]*"key":"[^"]+"/g) ?? []
    expect(autoFocused).toHaveLength(1)
    expect(autoFocused[0]).toContain('question-audience-option-0')

    await press($, 'question-audience-option-1')
    expect(await pane($)).not.toContain('"autoFocus":true')
  })

  test('an open pane redraws without a toast', async ($, on) => {
    const { world, panes } = await setup($, on, { isPaneOpen: true })
    await ask($)
    expect(world.toasts).toEqual([])
    expect([...panes]).toEqual(['brief'])
  })

  test('a terminal too narrow for an unasked pane gets the toast instead', async ($, on) => {
    const { world, panes } = await setup($, on, { isNarrow: true })
    await ask($)
    expect([...panes]).toEqual([])
    expect(world.toasts.at(-1)).toBe('3 questions wait in the Brief pane, press b')
    expect(await pane($)).toContain('Questions · from Claude · 3')
  })

  test('the Brief button closes a pane the questions opened', async ($, on) => {
    const { panes } = await setup($, on)
    await ask($)
    expect([...panes]).toEqual(['brief'])
    await $.ui.render(BAND)
    await $.ui.press({ plugin: 'agent-brief', key: 'brief' })
    expect([...panes]).toEqual([])
  })

  test('a bad input returns the usage and asks nothing', async ($, on) => {
    await setup($, on)
    expect(await ask($, [{ id: 'x', text: 'Pick', kind: 'select', options: ['only'] }])).toContain('ask_questions takes')
    expect(await pane($)).not.toContain('Questions · from Claude')
  })

  test('the band counts the questions, and the collapsed inline line names them', async ($, on) => {
    await setup($, on)
    await ask($)
    expect(JSON.stringify(await $.ui.render(BAND))).toContain('"label":"▣ Brief 4"')
    await $.ui.render(briefPane('inline'))
    await $.ui.press({ plugin: 'agent-brief', key: 'brief-expand' })
    expect(await pane($, 'inline')).toContain('1 item waiting · 3 questions waiting')
  })

  test('asking expands the inline seat so the questions show', async ($, on) => {
    await setup($, on)
    await ask($)
    const drawn = await pane($, 'inline')
    expect(drawn).toContain('Questions · from Claude')
    expect(drawn).toContain('"label":"▾ Collapse"')
  })

  test('asking again replaces the unanswered questions', async ($, on) => {
    await setup($, on)
    await ask($)
    await press($, 'question-audience-option-1')
    await ask($, [{ id: 'tone', text: 'What tone?', kind: 'text' }])
    const drawn = await pane($)
    expect(drawn).toContain('Questions · from Claude · 2')
    expect(drawn).toContain('Who reads it?')
    expect(drawn).toContain('What tone?')
    expect(drawn).not.toContain('How long?')
  })
})

describe('the Questions section', () => {
  test('Send answers submits each answer, then clears the section', async ($, on) => {
    const { world } = await setup($, on)
    await ask($)
    await press($, 'question-audience-option-1')
    await $.ui.render(briefPane())
    await $.ui.select({ plugin: 'agent-brief', key: 'question-length-select', value: 'One page' })
    await $.ui.render(briefPane())
    await $.ui.input({ plugin: 'agent-brief', key: 'question-goal-answer', text: 'Pick a vendor' })
    const drawn = await pane($)
    expect(drawn).toContain('→ ')
    expect(drawn).toContain('"label":"Send answers (3)"')

    await press($, 'questions-send')
    expect(world.submitted.at(-1)).toBe(
      ['Answers to your questions:', '- Who reads it?: Execs', '- How long?: One page', '- What should it decide?: Pick a vendor'].join('\n'),
    )
    expect(await pane($)).not.toContain('Questions · from Claude')
    expect(world.files.get(ITEMS_PATH)).toBe(ITEMS)
  })

  test('an unanswered question goes out as no answer', async ($, on) => {
    const { world } = await setup($, on)
    await ask($)
    await press($, 'question-audience-option-0')
    await press($, 'questions-send')
    expect(world.submitted.at(-1)).toBe(
      ['Answers to your questions:', '- Who reads it?: Engineers', '- How long?: (no answer)', '- What should it decide?: (no answer)'].join('\n'),
    )
  })

  test('Send with nothing answered says so and keeps the questions', async ($, on) => {
    const { world } = await setup($, on)
    await ask($)
    await press($, 'questions-send')
    expect(world.submitted).toEqual([])
    expect(world.toasts.at(-1)).toBe('Answer a question first, then Send answers.')
    expect(await pane($)).toContain('Questions · from Claude · 3')
  })

  test('Clear drops an answer', async ($, on) => {
    await setup($, on)
    await ask($)
    await press($, 'question-audience-option-0')
    await press($, 'question-audience-clear')
    expect(await pane($)).toContain('"label":"Send answers"')
  })

  test('the Items Send leaves the questions alone', async ($, on) => {
    const { world } = await setup($, on)
    await ask($)
    await press($, 'question-audience-option-0')
    await press($, 'item-1-option-0')
    await press($, 'brief-send')
    expect(world.submitted.at(-1)).toContain('Decisions on')
    expect(world.submitted.at(-1)).not.toContain('Answers to your questions')
    expect(await pane($)).toContain('"label":"Send answers (1)"')
  })

  test('Other opens a field under the options and sends the typed words', async ($, on) => {
    const { world } = await setup($, on)
    await ask($)
    let drawn = await pane($)
    expect(drawn).toContain('"key":"question-audience-other"')
    expect(drawn).not.toContain('"key":"question-audience-answer"')
    await press($, 'question-audience-other')
    drawn = await pane($)
    expect(drawn).toContain('"key":"question-audience-answer"')
    await $.ui.input({ plugin: 'agent-brief', key: 'question-audience-answer', text: 'Designers' })
    expect(await pane($)).toContain('"→ ","Designers"')
    await press($, 'questions-send')
    expect(world.submitted.at(-1)).toContain('- Who reads it?: Designers (their own words)')
  })

  test('Other on a select opens the field, and a listed pick closes it', async ($, on) => {
    await setup($, on)
    await ask($)
    expect(await pane($)).toContain('{"value":"__other__","label":"Other…"}')
    await $.ui.select({ plugin: 'agent-brief', key: 'question-length-select', value: '__other__' })
    expect(await pane($)).toContain('"key":"question-length-answer"')
    await $.ui.select({ plugin: 'agent-brief', key: 'question-length-select', value: 'Long' })
    const drawn = await pane($)
    expect(drawn).not.toContain('"key":"question-length-answer"')
    expect(drawn).toContain('"→ ","Long"')
  })

  test('a surface without a Select draws Buttons for a select question', async ($, on) => {
    await setup($, on)
    await ask($)
    const ui = await $.ui.mount({ plugin: 'agent-brief', surface: 'mobile', component: 'Pane', requestId: 'brief', props: briefPane().props })
    expect(await ui.find({ key: 'question-length-option-0' })).toBeDefined()
    expect(await ui.find({ key: 'question-length-select' })).toBeUndefined()
    expect(await ui.find({ text: 'Answer in the terminal.' })).toBeDefined()
    await ui.unmount()
  })
})

describe('/grill', () => {
  test('adds the grill section until /grill off', async ($, on) => {
    await setup($, on)
    expect(await sectionIds($)).not.toContain('agent-brief:grill')
    expect((await $.command.run(command('grill'))).text).toMatch(/^Grill on\./)
    expect(await grillText($)).toContain('`ask_questions` tool')
    expect((await $.command.run(command('grill'))).text).toMatch(/^Grill is already on\./)
    expect((await $.command.run(command('grill', 'off'))).text).toMatch(/^Grill off\./)
    expect(await sectionIds($)).not.toContain('agent-brief:grill')
    expect((await $.command.run(command('grill', 'loud'))).text).toBe('Usage: /grill [on|off]')
  })

  test('points at the reply when a policy refuses the tool', async ($, on) => {
    const { world } = await setup($, on, { isToolRefused: true })
    expect(world.tools).toEqual([])
    expect(world.commands).toContain('grill')
    await $.command.run(command('grill'))
    expect(await grillText($)).toContain('numbered list')
    expect(await grillText($, [ASK])).toContain('`ask_questions` tool')
  })
})
