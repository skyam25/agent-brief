#!/usr/bin/env node
/**
 * Live check of the Brief pane: a real interactive Claude Code session in tmux with this
 * checkout's mod, a stub companion server, and no model calls. Run by hand, never by
 * `claude plugin test`. It presses the band's Brief button and expects the pane to dock.
 *
 * The terminal is 117 columns by default, under the 144-column floor an unasked pane waits
 * for, so the check fails when the open stops counting as the user's press.
 *
 *   node tests/live/brief-pane.mjs            # 117 columns
 *   COLS=150 node tests/live/brief-pane.mjs
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const MOD = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const COMPANION = resolve(MOD, '../../companion')
const ESBUILD = join(COMPANION, 'node_modules/.bin/esbuild')
const TMUX = '/opt/homebrew/bin/tmux'
const SESSION = `brief-pane-${process.pid}`

const sleep = ms => new Promise(r => setTimeout(r, ms))
const tmp = mkdtempSync('/tmp/brief-pane-')
const project = join(tmp, 'demo-project')
mkdirSync(project)
mkdirSync(join(tmp, 'inbox'))
const socketPath = join(tmp, 's.sock')
let pane = ''
const tmux = (...args) => spawnSync(TMUX, args, { encoding: 'utf8' })
const capture = () => (pane = tmux('capture-pane', '-p', '-t', SESSION, '-S', '-60').stdout ?? '')
const keys = (...k) => tmux('send-keys', '-t', SESSION, ...k)
async function until(fn, timeoutMs, stepMs = 300) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    const v = await fn()
    if (v) return v
    await sleep(stepMs)
  }
  return false
}

const bundle = join(tmp, 'server.mjs')
execFileSync(ESBUILD, [join(COMPANION, 'src/server/index.ts'), '--bundle', '--platform=node', '--format=esm', `--outfile=${bundle}`, '--log-level=error'])
const { createCompanionServer } = await import(bundle)
const server = createCompanionServer({
  socketPath,
  backend: {
    health: () => ({ panelVisible: false, currentBoard: 'main' }),
    open: async req => ({ board: req.board ?? 'main' }),
    listBoards: async () => ({ boards: [], current: 'main' }),
    read: async board => ({ board, elements: [], bounds: { x: 0, y: 0, width: 0, height: 0 } }),
    png: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    draw: async () => ({ ids: [], batchId: 'b' }),
    update: async () => ({ ids: [], batchId: 'b' }),
    remove: async () => ({ ids: [], batchId: 'b' }),
  },
})
await server.listen()

try {
  const settings = join(tmp, 'settings.json')
  writeFileSync(settings, JSON.stringify({ pluginConfigs: { 'agent-brief': { options: { companionSocket: socketPath, inboxDir: join(tmp, 'inbox') } } } }))
  tmux('new-session', '-d', '-s', SESSION, '-x', process.env.COLS ?? '117', '-y', '50', '-c', project, `claude --plugin-dir ${MOD} --settings ${settings}`)
  const ready = await until(async () => {
    capture()
    if (/Yes, I trust this folder/.test(pane)) {
      keys('Down')
      await sleep(400)
      keys('Enter')
      return false
    }
    return /Try "|\? for shortcuts/.test(pane)
  }, 60_000, 1000)
  console.log('claude started:', Boolean(ready))
  const registered = await until(() => server.sessions().sessions.length > 0, 20_000)
  console.log('registered:', Boolean(registered))
  const sid = server.sessions().sessions[0]?.sessionId
  await sleep(1500)
  capture()
  console.log(`--- band before ---\n${pane.trimEnd().split('\n').slice(-8).join('\n')}\n---`)

  mkdirSync(join(project, '.feedback/outputs'), { recursive: true })
  mkdirSync(join(project, '.feedback/items'), { recursive: true })
  const now = Date.now()
  writeFileSync(join(project, `.feedback/outputs/${sid}.json`), JSON.stringify({
    version: 1,
    sessionId: sid,
    outputs: [
      { ref: 'docs/plan.md', title: 'Pricing plan', kind: 'markdown', tier: 'declared', status: 'ready', declaredAt: now - 2000 },
      { ref: 'mock/landing.html', title: 'Landing mock', kind: 'html', tier: 'declared', status: 'drafting', declaredAt: now - 1000 },
      { ref: 'notes/scratch.md', kind: 'markdown', tier: 'detected', origin: 'created', firstWriteAt: now },
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

  keys('C-x')
  await sleep(200)
  keys('Tab')
  await sleep(600)
  keys('b')
  const opened = await until(() => capture().includes('Brief ·'), 15_000, 500)
  await sleep(1000)
  capture()
  const rows = ['Outputs', 'Pricing plan', 'Items', '#2 Rows too tight', 'Send answers'].filter(t => !pane.includes(t))
  const ok = Boolean(opened) && rows.length === 0
  console.log(`${ok ? 'PASS' : 'FAIL'}  Brief pane at ${process.env.COLS ?? '117'} columns${opened ? '' : ': pane did not open'}${rows.length ? `: missing ${rows.join(', ')}` : ''}`)
  if (!ok) {
    console.log(`--- screen ---\n${pane.trimEnd()}\n---`)
    process.exitCode = 1
  }
  keys('Escape')
  await sleep(400)
  tmux('send-keys', '-t', SESSION, '-l', '/sketch')
  await sleep(800)
  keys('Enter')
  await sleep(2500)
  capture()
  const band = pane.split('\n').find(l => l.includes('Sketch ]')) ?? ''
  const keepsMode = band.includes('Mode')
  console.log(`${keepsMode ? 'PASS' : 'FAIL'}  band keeps Mode after a slash command`)
  if (!keepsMode) process.exitCode = 1
} finally {
  tmux('kill-session', '-t', SESSION)
  await server.close().catch(() => undefined)
  if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true })
}
