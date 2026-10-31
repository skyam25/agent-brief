import { describe, expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { REPLIES_KEPT, ROW_OPENS, changedBrief, filedNote, keepNote, keepReply, localUrlLabel, namedLocalUrls, namedPages, noTurnOpens, replyEndingWith, rowOpens } from '../hooks/companion-logic'
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
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('tool.call', { tool: 'Read' }, () => ({ result: { type: 'text', file: { content: '' } } }) as never)
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

  test('finds known paths that hold spaces, in the order the reply names them', () => {
    const reply = 'See docs/prd.md, then the spec at pricing/working/Approvals add-on PRD.md.'
    expect(namedPages(reply, '/proj', ['pricing/working/Approvals add-on PRD.md'])).toEqual(['docs/prd.md', 'pricing/working/Approvals add-on PRD.md'])
  })

  test('orders the row by what the turn did, then named pages, once each', () => {
    const turn = {
      ...noTurnOpens(),
      ready: [{ ref: 'w/PRD.md', title: 'Add-on PRD' }],
      brief: { id: 'i1', title: 'Pricing' },
      itemsWaiting: 1,
      feedback: [{ ref: 'w/PRD.md', open: 3 }],
    }
    expect(rowOpens(turn, ['w/PRD.md', 'a.html']).map(o => o.label)).toEqual([
      'Open Add-on PRD',
      'Open Pricing brief',
      '1 item waiting',
      'PRD.md feedback · 3 open',
    ])
    expect(rowOpens(noTurnOpens(), ['a.html', 'b.md']).map(o => o.label)).toEqual(['Review a.html', 'Open b.md'])
  })

  test('reads the brief an initiative create or update changed', () => {
    expect(changedBrief('created "Pricing" (id ab12) at /x/Pricing brief.md')).toEqual({ title: 'Pricing', id: 'ab12' })
    expect(changedBrief('updated "Pricing 2027" to revision 4')).toEqual({ title: 'Pricing 2027' })
    expect(changedBrief('attached Pricing')).toBeUndefined()
  })

  test('reads dev servers on this Mac, not other sites', () => {
    const reply = 'Running at http://localhost:5173. Settings: http://localhost:5173/settings?tab=2, (http://127.0.0.1:3000/) and https://example.com/a and http://app.local:8080'
    expect(namedLocalUrls(reply)).toEqual(['http://localhost:5173/', 'http://localhost:5173/settings?tab=2', 'http://127.0.0.1:3000/', 'http://app.local:8080/'])
    expect(localUrlLabel('http://localhost:5173/')).toBe('localhost:5173')
    expect(localUrlLabel('http://localhost:5173/settings?tab=2')).toBe('localhost:5173/settings?tab=2')
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

  test(`offers at most ${ROW_OPENS} pages`, async ($, on) => {
    const { world, clock, start } = await setup($, on)
    const names = Array.from({ length: ROW_OPENS + 2 }, (_, i) => `p${i}.html`)
    for (const name of names) world.files.set(`${CWD}/${name}`, '<p>')
    const reply = `Pages:\n${names.join(' ')}`
    await start()
    await clock.settle()
    await $.turn.complete(finish(reply))
    const ui = await $.ui.mount(block(reply))
    expect(await ui.find({ key: `reply-review-${ROW_OPENS - 1}` })).toMatchObject({ text: `Review p${ROW_OPENS - 1}.html` })
    expect(await ui.find({ key: `reply-review-${ROW_OPENS}` }).catch(() => undefined)).toBeUndefined()
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

  test('Open shows an outline the reply names, though Claude changed it through the CLI', async ($, on) => {
    const { app, world, clock, start } = await setup($, on)
    world.files.set(`${CWD}/plan/story.outline.md`, '# Story')
    await start()
    await clock.settle()
    const reply = `I've proposed a direction in the outline.\n\nFile changed:\n${CWD}/plan/story.outline.md\nAlso see plan/missing.outline.md`
    await $.turn.complete(finish(reply))
    const ui = await $.ui.mount(block(reply))
    expect(await ui.find({ key: 'reply-review-0' })).toMatchObject({ text: 'Open story.outline.md' })
    expect(textOf(await $.ui.render(block(reply))), 'an outline that does not exist').not.toContain('missing.outline.md ·')
    await ui.press({ key: 'reply-review-0' })
    await clock.settle()
    expect(app.to('POST', '/open').at(-1)!.body).toEqual({ sessionId: SESSION_ID, output: { path: 'plan/story.outline.md' } })
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

  test('a note replaced in place keeps the title an earlier turn filed it under', async ($, on) => {
    const { clock, start } = await setup($, on)
    let stdout = 'Saved "Reply to Dana" to this session\'s tab in Agent Brief, Write mode.\nTo show it, run: agent-brief open --note n-1'
    on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout, stderr: '' } }) as never)
    await start()
    await clock.settle()
    await $.tool.call({ tool: 'Bash', command: 'agent-brief note "Reply to Dana" <<EOF' } as never)
    await $.turn.complete(finish('Drafted the reply.'))
    stdout = 'Replaced the note.\nTo show it, run: agent-brief open --note n-1'
    await $.tool.call({ tool: 'Bash', command: 'agent-brief note --id n-1 <<EOF' } as never)
    await $.turn.complete(finish('Updated the reply.'))
    const ui = await $.ui.mount(block('Updated the reply.'))
    expect(await ui.find({ key: 'reply-note-n-1' })).toMatchObject({ text: 'Open Reply to Dana' })
    await ui.unmount()
  })

  test('offers what the turn made Ready, unnamed, and a file it read that the reply cites by a path with spaces', async ($, on) => {
    const { app, world, clock, start } = await setup($, on)
    world.files.set(`${CWD}/w/Add-on PRD.md`, '# PRD')
    world.files.set(`${CWD}/research/funnel oct.md`, '# Funnel')
    await start()
    await clock.settle()
    await $.turn.start({ text: 'go', turnId: 't1' } as never)
    await $.tool.call({ tool: 'Read', file_path: `${CWD}/research/funnel oct.md` } as never)
    await $.tool.call({ tool: 'mcp__agent-brief__declare_output', title: 'Add-on PRD', path: 'w/Add-on PRD.md', status: 'ready' } as never)
    const reply = 'Done. The drop is at step 3, per research/funnel oct.md.'
    await $.turn.complete(finish(reply))
    const ui = await $.ui.mount(block(reply))
    expect(await ui.find({ key: 'reply-review-0' })).toMatchObject({ text: 'Open Add-on PRD' })
    expect(await ui.find({ key: 'reply-review-1' })).toMatchObject({ text: 'Open funnel oct.md' })
    await ui.press({ key: 'reply-review-1' })
    await clock.settle()
    expect(app.to('POST', '/open').at(-1)!.body).toEqual({ sessionId: SESSION_ID, output: { path: 'research/funnel oct.md' } })
    await ui.unmount()
  })

  test('opens a Ready file or link the panel cannot show in its default app or the browser', async ($, on) => {
    const { app, world, clock, start } = await setup($, on)
    world.files.set(`${CWD}/out/deck.pdf`, '%PDF')
    await start()
    await clock.settle()
    await $.turn.start({ text: 'go', turnId: 't1' } as never)
    await $.tool.call({ tool: 'mcp__agent-brief__declare_output', title: 'Deck', path: 'out/deck.pdf', status: 'ready' } as never)
    await $.tool.call({ tool: 'mcp__agent-brief__declare_output', title: 'Live site', url: 'https://example.com/launch', status: 'ready' } as never)
    const reply = 'The deck and the site are ready.'
    await $.turn.complete(finish(reply))
    const ui = await $.ui.mount(block(reply))
    expect(await ui.find({ key: 'reply-review-0' })).toMatchObject({ text: 'Open Deck' })
    expect(await ui.find({ key: 'reply-review-1' })).toMatchObject({ text: 'Open Live site' })
    const opens = app.to('POST', '/open').length
    await ui.press({ key: 'reply-review-0' })
    await ui.press({ key: 'reply-review-1' })
    await clock.settle()
    expect(app.to('POST', '/open')).toHaveLength(opens)
    expect(world.runs.filter(r => r.argv[0] === 'open').map(r => r.argv)).toEqual([
      ['open', `${CWD}/out/deck.pdf`],
      ['open', 'https://example.com/launch'],
    ])
    await ui.unmount()
  })

  test('offers the brief a turn updated, and opens it on the Initiative tab', async ($, on) => {
    const { app, clock, start } = await setup($, on)
    on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: 'created "Pricing" (id ab12) at /x/Pricing brief.md', stderr: '' } }) as never)
    await start()
    await clock.settle()
    await $.turn.start({ text: 'go', turnId: 't1' } as never)
    await $.tool.call({ tool: 'Bash', command: 'agent-brief initiative create Pricing --folder /x' } as never)
    const reply = 'Created the Pricing initiative.'
    await $.turn.complete(finish(reply))
    const ui = await $.ui.mount(block(reply))
    expect(await ui.find({ key: 'reply-brief' })).toMatchObject({ text: 'Open Pricing brief' })
    await ui.press({ key: 'reply-brief' })
    await clock.settle()
    expect(app.to('POST', '/open').at(-1)!.body).toEqual({ sessionId: SESSION_ID, initiative: { id: 'ab12' } })
    await ui.unmount()
  })

  test('offers items waiting on the user only when the turn changed the items file', async ($, on) => {
    const { world, clock, start } = await setup($, on)
    const items = `${CWD}/.feedback/items/${SESSION_ID}.md`
    await start()
    await clock.settle()
    await $.turn.start({ text: 'go', turnId: 't1' } as never)
    world.files.set(items, '# Items · x\n\n- [ ] #1 Billing\n      Claude: Annual / Monthly\n- [x] #2 PRD\n      Claude: done\n')
    const reply = 'One question is in the panel.'
    await $.turn.complete(finish(reply))
    const ui = await $.ui.mount(block(reply))
    expect(await ui.find({ key: 'reply-items' })).toMatchObject({ text: '1 item waiting' })
    await ui.unmount()

    await $.turn.start({ text: 'next', turnId: 't2' } as never)
    await $.turn.complete(finish('Nothing changed.'))
    const next = await $.ui.mount(block('Nothing changed.'))
    expect(await next.find({ key: 'reply-items' }).catch(() => undefined)).toBeUndefined()
    await next.unmount()
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
