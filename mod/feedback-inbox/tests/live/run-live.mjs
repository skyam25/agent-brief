#!/usr/bin/env node
/**
 * Live check of the companion link against a real companion server and a real
 * interactive Claude Code session in tmux. Run by hand, never by `claude plugin test`.
 * It submits nothing to the model; it only uses slash commands and the prompt box.
 *
 *   node tests/live/run-live.mjs
 */

import { execFileSync, spawnSync } from 'node:child_process'
import http from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const MOD = resolve(HERE, '../..')
const COMPANION = process.env.COMPANION_DIR ?? resolve(MOD, '../../companion')
const ESBUILD = join(COMPANION, 'node_modules/.bin/esbuild')
const TMUX = process.env.TMUX_BIN ?? '/opt/homebrew/bin/tmux'
const SESSION = `live-${process.pid}`

const sleep = ms => new Promise(r => setTimeout(r, ms))
const tmp = mkdtempSync('/tmp/fi-live-')
const project = join(tmp, 'project')
mkdirSync(project)
const socketPath = join(tmp, 's.sock')
// An empty inbox keeps the mod's zip poller away from the real ~/Downloads/feedback-inbox.
mkdirSync(join(tmp, 'inbox'))
const failures = []
let server
let pane = ''

function report(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
  if (!ok) failures.push(name)
  return ok
}

const tmux = (...args) => spawnSync(TMUX, args, { encoding: 'utf8' })
const capture = () => (pane = tmux('capture-pane', '-p', '-t', SESSION, '-S', '-200').stdout ?? '')
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

/** Asks the real server over its socket. */
function ask(method, path) {
  return new Promise((res, rej) => {
    const req = http.request({ socketPath, method, path, agent: false }, r => {
      const chunks = []
      r.on('data', c => chunks.push(c))
      r.on('end', () => res(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')))
    })
    req.on('error', rej)
    req.end()
  })
}

async function cleanup() {
  tmux('kill-session', '-t', SESSION)
  await server?.close().catch(() => undefined)
  rmSync(tmp, { recursive: true, force: true })
}

async function main() {
  // 1. Real server, bundled from the companion repo, with a minimal backend.
  const bundle = join(tmp, 'server.mjs')
  execFileSync(ESBUILD, [join(COMPANION, 'src/server/index.ts'), '--bundle', '--platform=node', '--format=esm', `--outfile=${bundle}`, '--log-level=error'])
  const { createCompanionServer } = await import(bundle)
  const opens = []
  const backend = {
    health: () => ({ panelVisible: false, currentBoard: 'main' }),
    open: async req => (opens.push(req), { board: req.board ?? 'main' }),
    listBoards: async () => ({ boards: [], current: 'main' }),
    read: async board => ({ board, elements: [], bounds: { x: 0, y: 0, width: 0, height: 0 } }),
    png: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    draw: async () => ({ ids: [], batchId: 'b' }),
    update: async () => ({ ids: [], batchId: 'b' }),
    remove: async () => ({ ids: [], batchId: 'b' }),
  }
  server = createCompanionServer({ socketPath, backend })
  await server.listen()
  report('1 server listening', existsSync(socketPath))

  // 2. Interactive claude in tmux, with the socket set by a temp settings file.
  const settings = join(tmp, 'settings.json')
  writeFileSync(settings, JSON.stringify({ pluginConfigs: { 'feedback-inbox': { options: { companionSocket: socketPath, inboxDir: join(tmp, 'inbox') } } } }))
  tmux('new-session', '-d', '-s', SESSION, '-x', '160', '-y', '50', '-c', project,
    `claude --plugin-dir ${MOD} --settings ${settings}`)

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
  report('2 claude started', Boolean(ready))
  if (!ready) return

  // 3. The session registered.
  const registered = await until(() => server.sessions().sessions.length > 0, 20_000)
  const info = server.sessions().sessions[0]
  report('3 session registered', Boolean(registered), info ? `${info.sessionId} ${info.cwd}` : '')
  if (!registered) return
  const sessionId = info.sessionId
  server.setTarget(sessionId)

  // 4. A delivery after more than one long-poll lands in the box.
  console.log('    waiting 40 s for a long-poll cycle...')
  await sleep(40_000)
  const d1 = await server.deliver({ png: Buffer.from('89504e470d0a1a0a', 'hex'), scene: {}, boardName: 'main', speech: 'make the header bigger', mode: 'fill' })
  const draftLine = `@.feedback/sketches/${d1.id}/sketch.png`
  const shown = await until(() => capture().includes(draftLine), 15_000, 500)
  report('4 fill shows the draft in the prompt box', Boolean(shown))
  console.log(`--- pane (step 4) ---\n${pane.trimEnd()}\n--- end pane ---`)
  const files = ['sketch.png'].map(f => existsSync(join(project, '.feedback/sketches', d1.id, f)))
  report('4 bundle files exist in the project', files.every(Boolean))
  const acked = await until(async () => !(await ask('GET', `/deliveries?session=${sessionId}&wait=0`)).deliveries.some(d => d.id === d1.id), 10_000)
  report('4 delivery acked', Boolean(acked))

  // 5. Typed text survives a second fill.
  type('MY-TYPED-TEXT')
  await sleep(500)
  const d2 = await server.deliver({ png: Buffer.from('89504e470d0a1a0a', 'hex'), scene: {}, boardName: 'main', speech: 'second one', mode: 'fill' })
  const second = await until(() => capture().includes(`@.feedback/sketches/${d2.id}/sketch.png`), 15_000, 500)
  report('5 second draft shows', Boolean(second))
  report('5 typed text and first draft still show', pane.includes('MY-TYPED-TEXT') && pane.includes(draftLine))

  // 6. /sketch hello opens the panel for this session.
  for (let i = 0; i < 12; i++) keys('C-u')
  await sleep(500)
  capture()
  report('6 box cleared before /sketch', !pane.includes('MY-TYPED-TEXT') && !pane.includes('sketch.png'))
  type('/sketch hello')
  await sleep(800)
  keys('Enter')
  const opened = await until(() => opens.length > 0, 15_000)
  report('6 /sketch called open with sessionId and prompt', Boolean(opened) && opens[0].sessionId === sessionId && opens[0].prompt === 'hello', JSON.stringify(opens[0]))
  await sleep(1000)
  capture()
  console.log(`--- pane (step 6) ---\n${pane.trimEnd()}\n--- end pane ---`)

  // 7. Exit removes the session.
  for (let i = 0; i < 12; i++) keys('C-u')
  await sleep(300)
  type('/exit')
  await sleep(800)
  keys('Enter')
  const gone = await until(() => server.sessions().sessions.length === 0, 20_000)
  report('7 session removed on exit', Boolean(gone))
  console.log('    note: submit mode is not tested live because it would spend tokens.')
}

try {
  await main()
} catch (err) {
  report('harness error', false, String(err))
}
if (failures.length > 0) {
  console.log(`--- last pane ---\n${capture().trimEnd()}\n--- end pane ---`)
}
await cleanup()
console.log(failures.length === 0 ? 'ALL PASS' : `FAILED: ${failures.join('; ')}`)
process.exit(failures.length === 0 ? 0 : 1)
