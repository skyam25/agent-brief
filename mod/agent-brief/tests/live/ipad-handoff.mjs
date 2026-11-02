#!/usr/bin/env node
/**
 * Live check of the iPad hand-off: a real interactive Claude Code session in tmux with this
 * checkout's mod, a plain stub socket, and no model calls. Run by hand.
 *
 * The band shows ▭ iPad only while the stub says an iPad is paired. A press posts the prompt
 * box's text to /handoffs and leaves the box. `/sketch --ipad` with nothing paired answers
 * the app's sentence and takes the button away.
 *
 *   node tests/live/ipad-handoff.mjs            # 117 columns
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { join } from 'node:path'
import { sleep, terminal, until } from './harness.mjs'

const PAIR_FIRST = 'Pair an iPad first with Pair iPad in the app'
const tmp = mkdtempSync('/tmp/ipad-handoff-')
const project = join(tmp, 'demo-project')
mkdirSync(project)
mkdirSync(join(tmp, 'inbox'))
const socketPath = join(tmp, 's.sock')

let paired = false
const handoffs = []
const json = (res, status, body) => {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) })
  res.end(text)
}
const server = http.createServer((req, res) => {
  let raw = ''
  req.on('data', d => (raw += d))
  req.on('end', () => {
    const url = new URL(req.url, 'http://stub')
    const body = raw ? JSON.parse(raw) : undefined
    if (url.pathname === '/health') return json(res, 200, { ok: true, version: 1, pid: 1, panelVisible: false, currentBoard: 'main' })
    if (url.pathname === '/sessions' && req.method === 'POST') return json(res, 200, { sessions: [body], ipadPaired: paired })
    if (url.pathname === '/deliveries') return setTimeout(() => json(res, 200, { deliveries: [] }), 1000)
    if (url.pathname === '/boards') return json(res, 200, { boards: [], current: 'main' })
    if (url.pathname === '/initiatives/recent') return json(res, 200, [])
    if (url.pathname === '/handoffs' && req.method === 'POST') {
      if (!paired) return json(res, 409, { error: PAIR_FIRST, code: 'conflict' })
      handoffs.push(body)
      return json(res, 200, { id: 'h1', sessionId: body.sessionId, sessionLabel: 'demo', boardName: 'ipad', createdAt: 1, state: 'open' })
    }
    if (/^\/sessions\/[^/]+\/initiative$/.test(url.pathname)) { res.writeHead(204); return res.end() }
    if (/^\/sessions\/[^/]+$/.test(url.pathname)) return json(res, 200, { sessionId: 'x', cwd: project, trackItems: false })
    return json(res, 200, { ok: true })
  })
})
await new Promise(r => server.listen(socketPath, r))

const term = terminal(`ipad-handoff-${process.pid}`)
const results = []
const check = (name, ok) => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`)
}
const screen = () => term.capture({ lines: 0 })
const bandLines = () => screen().trimEnd().split('\n').slice(-8).join('\n')

try {
  const settings = join(tmp, 'settings.json')
  writeFileSync(settings, JSON.stringify({ pluginConfigs: { 'agent-brief': { options: { companionSocket: socketPath, inboxDir: join(tmp, 'inbox') } } } }))
  check('claude started', Boolean(await term.start({ cwd: project, cols: process.env.COLS ?? 117, args: `--settings ${settings}` })))
  check('band draws', Boolean(await until(() => screen().includes('✎ Sketch'), 20_000)))
  check('no iPad button while none is paired', !screen().includes('▭ iPad'))
  console.log(`--- unpaired ---\n${bandLines()}\n---`)

  paired = true
  check('iPad button appears after the next registration', Boolean(await until(() => screen().includes('▭ iPad'), 75_000, 1000)))
  console.log(`--- paired ---\n${bandLines()}\n---`)

  term.type('circle the broken step')
  await sleep(500)
  await term.pressBand('p')
  check('a press posts /handoffs', Boolean(await until(() => handoffs.length === 1, 10_000)))
  check('the box text is the ask', handoffs[0]?.prompt === 'circle the broken step')
  check('the session id is set', typeof handoffs[0]?.sessionId === 'string' && handoffs[0].sessionId.length > 0)
  check('a toast says it went', Boolean(await until(() => screen().includes('Sent to your iPad'), 5_000)))
  check('the box keeps its text', screen().includes('circle the broken step'))
  console.log(`--- after press ---\n${bandLines()}\n---`)

  term.keys('Escape')
  await sleep(300)
  term.keys('C-u')
  await sleep(300)
  paired = false
  term.type('/sketch --ipad')
  await sleep(400)
  term.keys('Enter')
  check('/sketch --ipad answers the app\'s sentence', Boolean(await until(() => screen().includes(PAIR_FIRST), 10_000)))
  check('the iPad button goes away', Boolean(await until(() => !screen().includes('▭ iPad'), 10_000)))
  console.log(`--- unpaired again ---\n${bandLines()}\n---`)
} finally {
  term.close()
  server.close()
  server.closeAllConnections()
  rmSync(tmp, { recursive: true, force: true })
}
const failed = results.filter(ok => !ok).length
console.log(failed ? `${failed} failed` : 'all passed')
process.exit(failed ? 1 : 0)
