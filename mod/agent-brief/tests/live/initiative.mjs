#!/usr/bin/env node
/**
 * Live check of the Initiative band, Brief pane Select and /initiative: a real interactive Claude Code
 * session in tmux with this checkout's mod, a stub app on a Unix socket, and no model calls.
 * Run by hand, never by `claude plugin test`.
 *
 *   node tests/live/initiative.mjs            # 117 columns
 *   COLS=110 node tests/live/initiative.mjs
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const MOD = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const TMUX = '/opt/homebrew/bin/tmux'
const SESSION = `initiative-${process.pid}`
const COLS = process.env.COLS ?? '117'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const tmp = mkdtempSync('/tmp/initiative-')
const project = join(tmp, 'demo-project')
mkdirSync(project)
mkdirSync(join(tmp, 'inbox'))
const socketPath = join(tmp, 's.sock')
let pane = ''
const tmux = (...args) => spawnSync(TMUX, args, { encoding: 'utf8' })
const capture = () => (pane = tmux('capture-pane', '-p', '-t', SESSION, '-S', '-60').stdout ?? '')
const keys = (...k) => tmux('send-keys', '-t', SESSION, ...k)
const type = text => tmux('send-keys', '-t', SESSION, '-l', text)
async function until(fn, timeoutMs, stepMs = 300) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    const v = await fn()
    if (v) return v
    await sleep(stepMs)
  }
  return false
}

// ── Stub app ──────────────────────────────────────────────────────────────

const base = { understanding: 'Monthly-first pricing is the plan.', decisions: [], open: ['Legal review'], folders: [] }
const initiatives = [
  { ...base, id: 'ini-pricing', title: 'Pricing', revision: 7 },
  { ...base, id: 'ini-onboarding', title: 'Onboarding', revision: 3 },
  { ...base, id: 'ini-checkout', title: 'Checkout', revision: 1 },
]
const sessions = new Set()
const attachments = new Map()
const calls = []

const server = createServer((req, res) => {
  let text = ''
  req.on('data', chunk => (text += chunk))
  req.on('end', async () => {
    const url = new URL(req.url, 'http://companion')
    const path = url.pathname
    calls.push(`${req.method} ${path}${text ? ` ${text}` : ''}`)
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(body === undefined ? '' : JSON.stringify(body))
    }
    const snapshotOf = id => {
      const held = attachments.get(id)
      const i = held && initiatives.find(x => x.id === held.id)
      return i && { ...i, attachmentRevision: held.attachmentRevision }
    }
    if (path === '/health') return send(200, { ok: true, version: 1, pid: process.pid, panelVisible: false, currentBoard: 'main' })
    if (path === '/sessions' && req.method === 'POST') {
      const { sessionId } = JSON.parse(text)
      // The first registration finds the session already attached to Pricing, as a resumed one would.
      if (!sessions.has(sessionId)) attachments.set(sessionId, { id: 'ini-pricing', attachmentRevision: 1 })
      sessions.add(sessionId)
      return send(200, { sessions: [] })
    }
    if (path === '/deliveries') {
      await sleep(2000)
      return send(200, { deliveries: [] })
    }
    if (path === '/initiatives/recent') return send(200, initiatives.map(({ id, title }) => ({ id, title, line: '', lastActiveAt: '' })))
    const attached = /^\/sessions\/([^/]+)\/initiative$/.exec(path)?.[1]
    if (attached) {
      const id = decodeURIComponent(attached)
      if (req.method === 'PUT') {
        const { initiativeId } = JSON.parse(text)
        attachments.set(id, { id: initiativeId, attachmentRevision: (attachments.get(id)?.attachmentRevision ?? 0) + 1 })
        return send(200, snapshotOf(id))
      }
      if (req.method === 'DELETE') return send(200, { detached: attachments.delete(id) })
      const snapshot = snapshotOf(id)
      return snapshot ? send(200, snapshot) : send(204)
    }
    if (/^\/sessions\/[^/]+$/.test(path)) return send(req.method === 'DELETE' ? 200 : 404, req.method === 'DELETE' ? { removed: true } : { error: 'not found', code: 'not_found' })
    return send(200, { ok: true })
  })
})
await new Promise(r => server.listen(socketPath, r))

const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `: ${detail}`}`)
  if (!ok) console.log(`--- screen ---\n${pane.trimEnd()}\n---`)
}
const bandLine = () => capture().split('\n').find(l => l.includes('Sketch ]') || l.includes('Initiative ')) ?? ''
/** Runs a slash command and waits for its answer. A model turn starting means the command went to Claude: it is stopped and fails. */
const run = async (line, waitFor) => {
  type(line)
  await sleep(800)
  keys('Enter')
  const seen = await until(() => capture().includes(waitFor) || /esc to interrupt/.test(pane), 10_000, 300)
  if (/esc to interrupt/.test(pane)) {
    keys('Escape')
    console.log(`${line} started a model turn`)
    return false
  }
  return seen
}
/** ctrl+x Tab focuses the band, then the hotkey presses its button. */
const bandKey = async key => {
  keys('C-x')
  await sleep(200)
  keys('Tab')
  await sleep(600)
  keys(key)
}

try {
  const settings = join(tmp, 'settings.json')
  writeFileSync(settings, JSON.stringify({ pluginConfigs: { 'agent-brief': { options: { companionSocket: socketPath, inboxDir: join(tmp, 'inbox') } } } }))
  tmux('new-session', '-d', '-s', SESSION, '-x', COLS, '-y', '50', '-c', project, `claude --plugin-dir ${MOD} --settings ${settings}`)
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
  const registered = await until(() => sessions.size > 0, 20_000)
  console.log('registered:', Boolean(registered))

  // The terminal draws a plain Button's hotkey before its label, as `i: change`.
  const attachedBand = await until(() => /Attached Pricing · (i: )?change/.test(bandLine()), 10_000, 500)
  check(`band reads Attached Pricing · change at ${COLS} columns`, Boolean(attachedBand))

  await bandKey('b')
  const paneLine = await until(() => /Initiative · revision 7 +Pricing ▾/.test(capture()), 15_000, 500)
  check('Brief pane opens on its Initiative Select', Boolean(paneLine))
  keys('Escape')
  await sleep(400)
  await bandKey('b')
  await until(() => !capture().includes('Brief · demo-project'), 5_000, 400)
  keys('Escape')
  await sleep(600)

  await bandKey('i')
  const row = await until(() => /Initiative.*Pricing.*Onboarding.*Checkout.*Detach.*Cancel/.test(bandLine()), 10_000, 400)
  check('change opens the pick row', Boolean(row))
  keys('Right')
  await sleep(300)
  keys('Enter')
  const moved = await until(() => /Attached Onboarding · (i: )?change/.test(bandLine()), 10_000, 400)
  check('a pick attaches over the socket', Boolean(moved) && calls.some(c => c.startsWith('PUT') && c.includes('ini-onboarding')), calls.filter(c => !c.includes('deliveries')).join(' | '))
  keys('Escape')
  await sleep(600)

  const off = await run('/initiative off', 'Detached from Onboarding.')
  await sleep(800)
  check('/initiative off detaches', Boolean(off) && !bandLine().includes('Attached') && calls.some(c => c.startsWith('DELETE') && c.includes('/initiative')))
  check('with none attached the band offers attach initiative', /(i: )?attach initiative/.test(bandLine()))

  const none = await run('/initiative refresh', 'This session has no initiative.')
  check('/initiative refresh with nothing attached says so', Boolean(none))

  // The held delivery poll keeps a connection open, so connections drop before the close.
  const closed = new Promise(r => server.close(r))
  server.closeAllConnections()
  await closed
  await sleep(500)
  const down = await run('/initiative off', 'Agent Brief is not running. Start it, then run /initiative again.')
  check('with the app gone, /initiative says so and the session carries on', Boolean(down) && /\? for shortcuts|Sketch \]/.test(capture()))
  if (results.some(ok => !ok)) process.exitCode = 1
} finally {
  tmux('kill-session', '-t', SESSION)
  server.close()
  server.closeAllConnections()
  if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true })
}
process.exit()
