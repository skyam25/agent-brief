#!/usr/bin/env node
/**
 * Live check of ask_questions: a real interactive Claude Code session in tmux with this
 * checkout's mod and a stub companion server. Run by hand, never by `claude plugin test`.
 * It costs one model call: the prompt asks Claude to call ask_questions, and the check
 * expects the Brief pane to open on its own with the questions in it.
 *
 * The open is the model's, not the user's, so the engine seats it only from 144 columns
 * (110 once the user has opened the pane in any session). Below that the pane waits and a toast says so.
 * Between 110 and 143 columns either is right, depending on that history.
 *
 *   node tests/live/questions-pane.mjs             # 117 columns: the pane or the toast
 *   COLS=150 node tests/live/questions-pane.mjs    # expects the pane
 *   MODEL=sonnet node tests/live/questions-pane.mjs
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { sleep, stubServer, terminal, until } from './harness.mjs'

const COLS = Number(process.env.COLS ?? '117')
const MODEL = process.env.MODEL ?? 'haiku'

const PROMPT =
  'Call the ask_questions tool exactly once with these two questions and nothing else, then stop: ' +
  'id audience, text "Who reads it?", kind options, options Engineers and Execs; ' +
  'id goal, text "What should it decide?", kind text.'

const tmp = mkdtempSync('/tmp/questions-pane-')
const project = join(tmp, 'demo-project')
mkdirSync(project)
mkdirSync(join(tmp, 'inbox'))
const socketPath = join(tmp, 's.sock')
const server = await stubServer(tmp, socketPath)
const term = terminal(`questions-pane-${process.pid}`)

try {
  const settings = join(tmp, 'settings.json')
  writeFileSync(
    settings,
    JSON.stringify({
      permissions: { allow: ['mcp__agent-brief__ask_questions'] },
      pluginConfigs: { 'agent-brief': { options: { companionSocket: socketPath, inboxDir: join(tmp, 'inbox') } } },
    }),
  )
  const ready = await term.start({ cwd: project, cols: COLS, args: `--settings ${settings} --model ${MODEL}` })
  console.log('claude started:', Boolean(ready))
  const registered = await until(() => server.sessions().sessions.length > 0, 20_000)
  console.log('registered:', Boolean(registered))
  await sleep(1500)

  term.type(PROMPT)
  await sleep(800)
  term.keys('Enter')
  const seen = await until(() => {
    term.capture()
    if (term.pane.includes('Questions · from Claude')) return 'pane'
    if (/questions? waits? in the Brief pane/.test(term.pane)) return 'toast'
    return false
  }, 120_000, 500)
  await sleep(1000)
  term.capture()
  const hasQuestion = term.pane.includes('Who reads it?')
  const expected = COLS >= 144 ? ['pane'] : COLS >= 110 ? ['pane', 'toast'] : ['toast']
  const ok = expected.includes(seen) && (seen === 'toast' || hasQuestion)
  const what = seen === 'pane' ? 'the pane opened on its own' : seen === 'toast' ? 'the pane waited and the toast said so' : 'neither the pane nor the toast showed'
  console.log(`${ok ? 'PASS' : 'FAIL'}  ask_questions at ${COLS} columns: ${what}${seen === 'pane' && !hasQuestion ? ', without the question' : ''}`)
  if (!ok) {
    console.log(`--- screen ---\n${term.pane.trimEnd()}\n---`)
    process.exitCode = 1
  }

  if (seen === 'pane') {
    // The pane takes the keyboard over an empty composer, with the ring on the first option.
    const first = term.focused()
    term.keys('Down')
    await sleep(500)
    const down = term.focused()
    term.keys('Up')
    await sleep(500)
    const up = term.focused()
    const walks = first.includes('Engineers') && down.includes('Execs') && up.includes('Engineers')
    console.log(`${walks ? 'PASS' : 'FAIL'}  arrows walk the options: ${first || 'nothing'}, Down to ${down || 'nothing'}, Up to ${up || 'nothing'}`)
    if (!walks) process.exitCode = 1
  }

  if (seen === 'toast') {
    // The band's Brief button is the user's press, so it seats the pane at any width.
    await term.pressBand('b')
    const opened = await until(() => term.capture().includes('Who reads it?'), 15_000, 500)
    console.log(`${opened ? 'PASS' : 'FAIL'}  the Brief button then shows the questions`)
    if (!opened) {
      console.log(`--- screen ---\n${term.pane.trimEnd()}\n---`)
      process.exitCode = 1
    }
  }
} finally {
  term.close()
  await server.close().catch(() => undefined)
  if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true })
}
