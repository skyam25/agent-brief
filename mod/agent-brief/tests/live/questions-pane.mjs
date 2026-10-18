#!/usr/bin/env node
/**
 * Live check of ask_questions: a real interactive Claude Code session in tmux with this
 * checkout's mod and a stub companion server. Run by hand, never by `claude plugin test`.
 * It costs one model call: the prompt asks Claude to call ask_questions, and the check
 * expects the Brief pane to open on its own with the questions in it.
 *
 * The open is the model's, not the user's, so the engine seats it only from 144 columns
 * (110 once the user has opened the pane). Below that the pane waits and a toast says so.
 * The check reports which of the two it saw, and passes on either as long as the user was told.
 *
 *   node tests/live/questions-pane.mjs             # 117 columns: expects the toast
 *   COLS=150 node tests/live/questions-pane.mjs    # expects the pane
 *   MODEL=sonnet node tests/live/questions-pane.mjs
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const MOD = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const COMPANION = resolve(MOD, '../../companion')
const ESBUILD = join(COMPANION, 'node_modules/.bin/esbuild')
const TMUX = '/opt/homebrew/bin/tmux'
const SESSION = `questions-pane-${process.pid}`
const COLS = Number(process.env.COLS ?? '117')
const MODEL = process.env.MODEL ?? 'haiku'

const PROMPT =
  'Call the ask_questions tool exactly once with these two questions and nothing else, then stop: ' +
  'id audience, text "Who reads it?", kind options, options Engineers and Execs; ' +
  'id goal, text "What should it decide?", kind text.'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const tmp = mkdtempSync('/tmp/questions-pane-')
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
  writeFileSync(
    settings,
    JSON.stringify({
      permissions: { allow: ['mcp__agent-brief__ask_questions'] },
      pluginConfigs: { 'agent-brief': { options: { companionSocket: socketPath, inboxDir: join(tmp, 'inbox') } } },
    }),
  )
  tmux('new-session', '-d', '-s', SESSION, '-x', String(COLS), '-y', '50', '-c', project, `claude --plugin-dir ${MOD} --settings ${settings} --model ${MODEL}`)
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
  await sleep(1500)

  tmux('send-keys', '-t', SESSION, '-l', PROMPT)
  await sleep(800)
  keys('Enter')
  const seen = await until(() => {
    capture()
    if (pane.includes('Questions · from Claude')) return 'pane'
    if (/questions? waits? in the Brief pane/.test(pane)) return 'toast'
    return false
  }, 120_000, 500)
  await sleep(1000)
  capture()
  const hasQuestion = pane.includes('Who reads it?')
  const expected = COLS >= 144 ? 'pane' : 'toast'
  const ok = seen === expected && (seen === 'toast' || hasQuestion)
  const what = seen === 'pane' ? 'the pane opened on its own' : seen === 'toast' ? 'the pane waited and the toast said so' : 'neither the pane nor the toast showed'
  console.log(`${ok ? 'PASS' : 'FAIL'}  ask_questions at ${COLS} columns: ${what}${seen === 'pane' && !hasQuestion ? ', without the question' : ''}`)
  if (!ok) {
    console.log(`--- screen ---\n${pane.trimEnd()}\n---`)
    process.exitCode = 1
  }

  if (seen === 'toast') {
    // The band's Brief button is the user's press, so it seats the pane at any width.
    keys('C-x')
    await sleep(200)
    keys('Tab')
    await sleep(600)
    keys('b')
    const opened = await until(() => capture().includes('Who reads it?'), 15_000, 500)
    console.log(`${opened ? 'PASS' : 'FAIL'}  the Brief button then shows the questions`)
    if (!opened) {
      console.log(`--- screen ---\n${pane.trimEnd()}\n---`)
      process.exitCode = 1
    }
  }
} finally {
  tmux('kill-session', '-t', SESSION)
  await server.close().catch(() => undefined)
  if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true })
}
