import { describe, expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { REPLIES_KEPT, REVIEWS_SHOWN, filedNote, keepNote, keepReply, namedPages, replyEndingWith } from '../hooks/companion-logic'
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
    expect(replyEndingWith(['Done.'], 'Done.'), 'a one-line reply').toBe('Done.')
  })
})

describe('which pages and notes the row offers', () => {
  test('finds absolute, file:// and relative pages inside the project, once each, in order, as project paths', () => {
    const reply = [
      'Files the builder wrote:',
      '/proj/prototype/option-d.html',
      'file:///proj/handoffs/old.htm and `mock/landing.html`',
      'Again: /proj/prototype/option-d.html, ./mock/../mock/landing.html, docs/prd.md.',
    ].join('\n')
    expect(namedPages(reply, '/proj')).toEqual(['prototype/option-d.html', 'handoffs/old.htm', 'mock/landing.html', 'docs/prd.md'])
  })

  test('skips pages outside the project, URLs and names inside longer words', () => {
    const reply = '/elsewhere/a.html ../b.html https://x.com/c.html d.html5 e.htmlx /proj/f.html'
    expect(namedPages(reply, '/proj/')).toEqual(['f.html'])
  })

  test('reads the note `agent-brief note` filed, and keeps one entry per note', () => {
    const saved = [
      'Saved "Slack: launch" to this session\'s tab in Agent Brief, Write mode. The user can edit it there and press Copy.',
      'To show it, run: agent-brief open --note n-1',
      'To change it later, run: agent-brief note --id n-1 with the full new text',
    ].join('\n')
    expect(filedNote(saved)).toEqual({ id: 'n-1', title: 'Slack: launch' })
    const updated = filedNote('Updated note n-1 in place in Agent Brief.\nTo show it, run: agent-brief open --note n-1')
    expect(updated).toEqual({ id: 'n-1' })
    expect(filedNote('added 3 elements')).toBeUndefined()
    expect(keepNote([{ id: 'n-1', title: 'Slack: launch' }], updated!)).toEqual([{ id: 'n-1', title: 'Slack: launch' }])
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
    expect(app.to('POST', '/open').at(-1)!.body).toEqual({ sessionId: SESSION_ID, output: { path: 'prototype/option-d.html' } })
    await ui.unmount()
  })

  test(`offers at most ${REVIEWS_SHOWN} pages`, async ($, on) => {
    const { world, clock, start } = await setup($, on)
    const names = Array.from({ length: REVIEWS_SHOWN + 2 }, (_, i) => `p${i}.html`)
    for (const name of names) world.files.set(`${CWD}/${name}`, '<p>')
    const reply = `Pages:\n${names.join(' ')}`
    await start()
    await clock.settle()
    await $.turn.complete(finish(reply))
    const ui = await $.ui.mount(block(reply))
    expect(await ui.find({ key: `reply-review-${REVIEWS_SHOWN - 1}` })).toMatchObject({ text: `Review p${REVIEWS_SHOWN - 1}.html` })
    expect(await ui.find({ key: `reply-review-${REVIEWS_SHOWN}` }).catch(() => undefined)).toBeUndefined()
    await ui.unmount()
  })

  test('Open shows a Markdown output the reply names in Write, and skips Markdown that is not an output', async ($, on) => {
    const { app, world, clock, start } = await setup($, on)
    world.files.set(`${CWD}/docs/prd.md`, '# PRD')
    world.files.set(`${CWD}/README.md`, '# Readme')
    await start()
    await clock.settle()
    await $.tool.call({ tool: 'mcp__agent-brief__declare_output', title: 'PRD', path: 'docs/prd.md', status: 'ready' } as never)
    const reply = 'I wrote the PRD to docs/prd.md and left README.md alone.'
    await $.turn.complete(finish(reply))
    const ui = await $.ui.mount(block(reply))
    expect(await ui.find({ key: 'reply-review-0' })).toMatchObject({ text: 'Open prd.md' })
    expect(textOf(await $.ui.render(block(reply))), 'a one-line reply carries only the opens').not.toContain('Copy')
    expect(textOf(await $.ui.render(block(reply)))).not.toContain('README')
    await ui.press({ key: 'reply-review-0' })
    await clock.settle()
    expect(app.to('POST', '/open').at(-1)!.body).toEqual({ sessionId: SESSION_ID, output: { path: 'docs/prd.md' } })
    await ui.unmount()
  })

  test('a note the turn filed gets an Open on its reply, which shows it in Write', async ($, on) => {
    const { app, clock, start } = await setup($, on)
    on('tool.call', { tool: 'Bash' }, () =>
      ({
        result: {
          stdout: 'Saved "Slack: launch" to this session\'s tab in Agent Brief, Write mode.\nTo show it, run: agent-brief open --note n-1',
          stderr: '',
        },
      }) as never,
    )
    await start()
    await clock.settle()
    await $.tool.call({ tool: 'Bash', command: 'agent-brief note "Slack: launch" <<EOF' } as never)
    const reply = 'The Slack message is in Agent Brief, ready to copy.'
    await $.turn.complete(finish(reply))
    const ui = await $.ui.mount(block(reply))
    expect(await ui.find({ key: 'reply-note-n-1' })).toMatchObject({ text: 'Open Slack: launch' })
    await ui.press({ key: 'reply-note-n-1' })
    await clock.settle()
    expect(app.to('POST', '/open').at(-1)!.body).toEqual({ note: { id: 'n-1' } })
    await ui.unmount()

    await $.turn.complete(finish('Anything else?'))
    expect(textOf(await $.ui.render(block('Anything else?'))), 'the next reply filed no note').not.toContain('Open')
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
