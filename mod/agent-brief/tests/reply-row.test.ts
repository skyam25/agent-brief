import { describe, expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { REPLIES_KEPT, keepReply, replyEndingWith } from '../hooks/companion-logic'
import { SESSION_ID, setupCompanion } from './companion-world'
import { textOf } from './world'

const REPLY = 'Here is the post:\n\nWe shipped **v2** today.'

const block = (text: string, extra: Record<string, unknown> = {}) => ({
  plugin: 'agent-brief',
  surface: 'terminal' as const,
  component: 'AssistantMessage' as const,
  requestId: 'm1',
  viewport: { columns: 120, rows: 40, isFullscreen: true },
  props: { text, isFirstOfReply: true, ...extra },
})

const finish = (answer: string, extra: Record<string, unknown> = {}) => ({
  answer,
  durationMs: 10,
  isAborted: false,
  turnId: 't1',
  reason: 'answer' as const,
  ...extra,
})

/** The companion world, with core's own answer to a finished turn beneath the plugin. */
async function setup($: Parameters<TestBody>[0], on: Parameters<TestBody>[1]) {
  const seated = await setupCompanion($, on)
  on('turn.complete', () => ({ text: '' }))
  return seated
}

describe('which block carries the row', () => {
  test('keeps each reply once, newest last, and only the latest few', () => {
    expect(keepReply(['a\nb'], '  a\nb ')).toEqual(['a\nb'])
    expect(keepReply([], '   ')).toEqual([])
    const many = Array.from({ length: REPLIES_KEPT + 3 }, (_, i) => `r${i}`).reduce(keepReply, [] as string[])
    expect(many).toHaveLength(REPLIES_KEPT)
    expect(many.at(-1)).toBe(`r${REPLIES_KEPT + 2}`)
  })

  test('matches the block that ends a reply and holds most of it', () => {
    expect(replyEndingWith([REPLY], REPLY)).toBe(REPLY)
    expect(replyEndingWith([REPLY], 'We shipped **v2**\ntoday.')).toBe(REPLY)
    expect(replyEndingWith([REPLY], 'today.'), 'a short tail is a different block').toBeUndefined()
    expect(replyEndingWith([REPLY], 'Here is the post:'), 'a block before the end').toBeUndefined()
    expect(replyEndingWith(['Done.'], 'Done.'), 'a one-line reply').toBeUndefined()
  })
})

describe('the row under a finished reply', () => {
  test('draws Copy and Open in Agent Brief under the last block of a finished reply', async ($, on) => {
    const { clock, start } = await setup($, on)
    await start()
    await clock.settle()
    expect(textOf(await $.ui.render(block(REPLY))), 'no row before the turn ends').not.toContain('Copy')
    await $.turn.complete(finish(REPLY))
    const ui = await $.ui.mount(block(REPLY))
    expect(await ui.find({ key: 'reply-copy' })).toMatchObject({ text: 'Copy' })
    expect(await ui.find({ key: 'reply-open' })).toMatchObject({ text: 'Open in Agent Brief' })
    await ui.unmount()
  })

  test('draws nothing for a summary, a one-line reply or a subagent', async ($, on) => {
    const { clock, start } = await setup($, on)
    await start()
    await clock.settle()
    await $.turn.complete(finish(REPLY))
    expect(textOf(await $.ui.render(block(REPLY, { isSummary: true })))).not.toContain('Copy')
    await $.turn.complete(finish('All done.'))
    expect(textOf(await $.ui.render(block('All done.')))).not.toContain('Copy')
    await $.turn.complete(finish('Sub\nreport', { agentId: 'a1' }))
    expect(textOf(await $.ui.render(block('Sub\nreport')))).not.toContain('Copy')
  })

  test('Copy puts the reply on the clipboard and says so', async ($, on) => {
    const { world, clock, start } = await setup($, on)
    const copied: string[] = []
    on('ui.copy', ($, e) => {
      copied.push(e.text)
      return { value: { isCopied: true as const } }
    })
    await start()
    await clock.settle()
    await $.turn.complete(finish(REPLY))
    const ui = await $.ui.mount(block(REPLY))
    await ui.press({ key: 'reply-copy' })
    expect(copied).toEqual([REPLY])
    expect(world.toasts).toEqual(['Reply copied'])
    await ui.unmount()
  })

  test('Open in Agent Brief opens a note with the reply, quietly', async ($, on) => {
    const { app, world, clock, start } = await setup($, on)
    await start()
    await clock.settle()
    await $.turn.complete(finish(REPLY))
    const ui = await $.ui.mount(block(REPLY))
    await ui.press({ key: 'reply-open' })
    expect(app.to('POST', '/open')[0]!.body).toEqual({ sessionId: SESSION_ID, mode: 'write', text: REPLY })
    expect(world.toasts).toEqual([])
    await ui.unmount()
  })
})
