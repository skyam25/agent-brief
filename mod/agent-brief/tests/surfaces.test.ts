import { describe, expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { SESSION_ID, fakeCompanion } from './companion-world'
import { BAND, CWD, SESSION, briefPane, worldOf } from './world'

const ITEMS =
  '- [ ] #1 Rows\n      Claude: Tight or loose?\n- [ ] #2 Copy\n      Claude: What should it say?\n- [ ] #3 Gap\n      Claude: Use 8px gaps.\n'

async function setup($: Parameters<TestBody>[0], on: Parameters<TestBody>[1]) {
  const world = worldOf(on)
  world.files.set(`${CWD}/.feedback/items/${SESSION_ID}.md`, ITEMS)
  const clock = mock.clock(on)
  mock.store(on)
  fakeCompanion(on, clock)
  await $.session.start(SESSION)
  await clock.settle()
}

describe('the band above the prompt', () => {
  test('draws every button on the terminal and the desktop', async ($, on) => {
    await setup($, on)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'agent-brief', surface, component: 'AbovePrompt', props: BAND.props })
      for (const key of ['sketch', 'stack', 'write', 'talk', 'mode', 'brief']) {
        expect(await ui.find({ key }), `${key} on ${surface}`).toBeDefined()
      }
      await ui.unmount()
    }
  })
})

describe('the Brief pane', () => {
  test('draws on every surface, with fields where the surface has them', async ($, on) => {
    await setup($, on)
    for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
      const ui = await $.ui.mount({ plugin: 'agent-brief', surface, component: 'Pane', requestId: 'brief', props: briefPane().props })
      expect(await ui.find({ key: 'item-1-option-0' }), `options on ${surface}`).toBeDefined()
      expect(await ui.find({ key: 'brief-track' }), `Track on ${surface}`).toBeDefined()
      const hasFields = surface !== 'mobile'
      expect((await ui.find({ key: 'item-2-answer' })) !== undefined, `Input on ${surface}`).toBe(hasFields)
      expect((await ui.find({ key: 'brief-mode' })) !== undefined, `Select on ${surface}`).toBe(hasFields)
      await ui.unmount()
    }
  })

  test('on mobile, an item that needs typing draws a hint, a proposal keeps Agree, and the header names the mode', async ($, on) => {
    await setup($, on)
    const ui = await $.ui.mount({ plugin: 'agent-brief', surface: 'mobile', component: 'Pane', requestId: 'brief', props: briefPane().props })
    expect((await ui.find({ key: 'item-2' }))?.text).toContain('Answer in the terminal or in Agent Brief.')
    expect((await ui.find({ key: 'item-3' }))?.text).toContain('Answer in the terminal or in Agent Brief.')
    expect(await ui.find({ key: 'item-3-agree' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Default' })).toBeDefined()
    await ui.unmount()
  })
})
