import { describe, expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { REPLIES_KEPT, REVIEWS_SHOWN, keepReply, replyEndingWith, reviewablePages } from '../hooks/companion-logic'
import { SESSION_ID, setupCompanion } from './companion-world'
import { CWD, textOf } from './world'

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

describe('which pages the row offers to review', () => {
  test('finds absolute, file:// and relative HTML paths inside the project, once each, in order', () => {
    const reply = [
      'Files the builder wrote:',
      '/proj/prototype/option-d.html',
      'file:///proj/handoffs/old.htm and `mock/landing.html`',
      'Again: /proj/prototype/option-d.html, ./mock/../mock/landing.html.',
    ].join('\n')
    expect(reviewablePages(reply, '/proj')).toEqual(['/proj/prototype/option-d.html', '/proj/handoffs/old.htm', '/proj/mock/landing.html'])
  })

  test('skips pages outside the project, Markdown, URLs and names inside longer words', () => {
    const reply = '/elsewhere/a.html ../b.html notes.md https://x.com/c.html d.html5 e.htmlx /proj/f.html'
    expect(reviewablePages(reply, '/proj/')).toEqual(['/proj/f.html'])
  })

  test(`offers at most ${REVIEWS_SHOWN}`, () => {
    const reply = Array.from({ length: REVIEWS_SHOWN + 2 }, (_, i) => `p${i}.html`).join(' ')
    expect(reviewablePages(reply, '/proj')).toHaveLength(REVIEWS_SHOWN)
  })
})

describe('the row under a finished reply', () => {
  test('draws Copy and Open as note under the last block of a finished reply', async ($, on) => {
    const { clock, start } = await setup($, on)
    await start()
    await clock.settle()
    expect(textOf(await $.ui.render(block(REPLY))), 'no row before the turn ends').not.toContain('Copy')
    await $.turn.complete(finish(REPLY))
    const ui = await $.ui.mount(block(REPLY))
    expect(await ui.find({ key: 'reply-copy' })).toMatchObject({ text: 'Copy' })
    expect(await ui.find({ key: 'reply-open' })).toMatchObject({ text: 'Open as note' })
    expect(textOf(await $.ui.render(block(REPLY))), 'no page, no Review').not.toContain('Review')
    await ui.unmount()
  })

  test('Review opens each page the reply names that exists, in the review pane', async ($, on) => {
    const { app, world, clock, start } = await setup($, on)
    world.files.set(`${CWD}/prototype/option-d.html`, '<h1>D</h1>')
    const reply = `The builder is done.\n\nFiles it wrote:\n${CWD}/prototype/option-d.html\n${CWD}/prototype/option-e.html`
    await start()
    await clock.settle()
    await $.turn.complete(finish(reply))
    const ui = await $.ui.mount(block(reply))
    expect(await ui.find({ key: 'reply-review-0' })).toMatchObject({ text: 'Review option-d.html' })
    expect(textOf(await $.ui.render(block(reply))), 'a page not written yet').not.toContain('option-e.html ·')
    expect(textOf(await $.ui.render(block(reply)))).not.toContain('Review option-e.html')
    await ui.press({ key: 'reply-review-0' })
    await clock.settle()
    expect(app.to('POST', '/open').at(-1)!.body).toEqual({ sessionId: SESSION_ID, output: { path: `${CWD}/prototype/option-d.html` } })
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

  test('Open as note opens a note with the reply, quietly', async ($, on) => {
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
