#!/usr/bin/env node
/**
 * Live check of the Brief pane: a real interactive Claude Code session in tmux with this
 * checkout's mod, a stub companion server, and no model calls. Run by hand, never by
 * `claude plugin test`. It presses the band's Brief button and expects the pane to dock,
 * with the landing mock's feedback count, and In Agent Brief asking for its Feedback tab.
 *
 * The terminal is 117 columns by default, under the 144-column floor an unasked pane waits
 * for, so the check fails when the open stops counting as the user's press.
 *
 *   node tests/live/brief-pane.mjs            # 117 columns
 *   COLS=150 node tests/live/brief-pane.mjs
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { sleep, stubServer, terminal, until } from './harness.mjs'

const tmp = mkdtempSync('/tmp/brief-pane-')
const project = join(tmp, 'demo-project')
mkdirSync(project)
mkdirSync(join(tmp, 'inbox'))
const socketPath = join(tmp, 's.sock')
const opens = []
const server = await stubServer(tmp, socketPath, {
  open: async req => {
    opens.push(req)
    return { board: 'main', ...(req.output ? { opened: 'review' } : {}) }
  },
})
const term = terminal(`brief-pane-${process.pid}`)

try {
  const settings = join(tmp, 'settings.json')
  writeFileSync(settings, JSON.stringify({ pluginConfigs: { 'agent-brief': { options: { companionSocket: socketPath, inboxDir: join(tmp, 'inbox') } } } }))
  const ready = await term.start({ cwd: project, cols: process.env.COLS ?? 117, args: `--settings ${settings}` })
  console.log('claude started:', Boolean(ready))
  const registered = await until(() => server.sessions().sessions.length > 0, 20_000)
  console.log('registered:', Boolean(registered))
  const sid = server.sessions().sessions[0]?.sessionId
  await sleep(1500)
  term.capture()
  console.log(`--- band before ---\n${term.pane.trimEnd().split('\n').slice(-8).join('\n')}\n---`)

  mkdirSync(join(project, '.feedback/outputs'), { recursive: true })
  mkdirSync(join(project, '.feedback/items'), { recursive: true })
  const now = Date.now()
  writeFileSync(join(project, `.feedback/outputs/${sid}.json`), JSON.stringify({
    version: 1,
    sessionId: sid,
    outputs: [
      { ref: 'docs/plan.md', title: 'Pricing plan', kind: 'markdown', tier: 'declared', status: 'ready', declaredAt: now - 5 * 60_000 },
      { ref: 'mock/landing.html', title: 'Landing mock', kind: 'html', tier: 'declared', status: 'drafting', declaredAt: now - 1000 },
      { ref: 'notes/scratch.md', kind: 'markdown', tier: 'detected', origin: 'created', firstWriteAt: now, lastWriteAt: now },
    ],
  }, null, 2))
  writeFileSync(join(project, `.feedback/items/${sid}.md`), [
    '# Items · landing review',
    '',
    '- [ ] #3 Hero copy',
    '      Claude: What should the headline promise?',
    '- [ ] #2 Rows too tight',
    '      Claude: 44px rows or 40px rows?',
    '- [ ] #1 Button colour',
    '      Claude: Use the brand violet for the primary button.',
    '- [x] #0 Footer links',
    '      Claude: done',
    '',
  ].join('\n'))
  mkdirSync(join(project, 'mock'), { recursive: true })
  writeFileSync(join(project, 'mock/landing.html'), '<h1>Landing</h1>')
  writeFileSync(join(project, 'mock/landing.html.feedback.md'), [
    '# Feedback · landing.html',
    '',
    '## Round 1 · customers · 2026-10-12',
    '',
    '- [ ] #1 Hero is vague',
    '    Claude: 2026-10-12 · cataloged',
    '- [ ] #2 Pricing hidden',
    '    Claude: 2026-10-12 · cataloged',
    '- [x] #3 Footer',
    '    Claude: 2026-10-12 · done',
    '',
  ].join('\n'))

  await term.pressBand('b')
  const opened = await until(() => term.capture().includes('Brief ·'), 15_000, 500)
  await sleep(1000)
  term.capture()
  const rows = ['Outputs', 'Pricing plan', '5m ago', 'just now', 'Feedback · 2 open', 'Items', '#2 Rows too tight', 'Send answers'].filter(t => !term.pane.includes(t))
  const ok = Boolean(opened) && rows.length === 0
  console.log(`${ok ? 'PASS' : 'FAIL'}  Brief pane at ${process.env.COLS ?? '117'} columns${opened ? '' : ': pane did not open'}${rows.length ? `: missing ${rows.join(', ')}` : ''}`)
  if (!ok) {
    console.log(`--- screen ---\n${term.pane.trimEnd()}\n---`)
    process.exitCode = 1
  }
  // The landing mock is the first row, so the first In Agent Brief is its own.
  const clicked = await term.click('In Agent Brief')
  await until(() => opens.some(r => r.output), 5_000, 300)
  const asked = opens.find(r => r.output)?.output
  const tabbed = clicked && asked?.path === 'mock/landing.html' && asked?.tab === 'feedback'
  console.log(`${tabbed ? 'PASS' : 'FAIL'}  In Agent Brief opens the landing mock on its Feedback tab${tabbed ? '' : `: ${JSON.stringify(asked ?? null)}`}`)
  if (!tabbed) process.exitCode = 1

  // Escape hands the keys back but leaves the pane docked. The band's b closes it.
  term.keys('Escape')
  await sleep(400)
  await term.pressBand('b')
  await until(() => !term.capture().includes('Brief ·'), 5_000, 300)
  term.keys('Escape')
  await sleep(400)
  term.type('/sketch')
  await sleep(800)
  term.keys('Enter')
  await sleep(2500)
  term.capture()
  const band = term.pane.split('\n').find(l => l.includes('Sketch ]')) ?? ''
  const keepsMode = band.includes('Mode')
  console.log(`${keepsMode ? 'PASS' : 'FAIL'}  band keeps Mode after a slash command`)
  if (!keepsMode) {
    console.log(`--- screen ---\n${term.pane.trimEnd().split('\n').slice(-14).join('\n')}\n---`)
    process.exitCode = 1
  }
} finally {
  term.close()
  await server.close().catch(() => undefined)
  if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true })
}
