import { describe, expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { fakeCompanion } from './companion-world'
import { BAND, SESSION, worldOf } from './world'

async function setup($: Parameters<TestBody>[0], on: Parameters<TestBody>[1]) {
  worldOf(on)
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
      for (const key of ['sketch', 'stack', 'write', 'track', 'mode']) {
        expect(await ui.find({ key }), `${key} on ${surface}`).toBeDefined()
      }
      await ui.unmount()
    }
  })
})
