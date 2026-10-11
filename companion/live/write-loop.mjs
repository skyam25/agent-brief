#!/usr/bin/env node
/**
 * Write mode, live: a PM's day with the real app (test mode, off screen), the
 * real agent-brief mod and an interactive Claude Code in tmux. Delivery runs in
 * fill mode, so drafts land in the prompt box and nothing reaches the model.
 *
 *   cd companion && node live/write-loop.mjs
 */

import { _electron as electron } from '@playwright/test'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MOD = process.env.MOD_DIR ?? resolve(ROOT, '../mod/agent-brief')
const TMUX = process.env.TMUX_BIN ?? '/opt/homebrew/bin/tmux'
const TMUX_SESSION = `writeloop-${process.pid}`
const SHOTS = process.env.SHOTS_DIR ?? join(ROOT, 'test-results/write-loop')
mkdirSync(SHOTS, { recursive: true })

const sleep = ms => new Promise(r => setTimeout(r, ms))
const tmp = mkdtempSync('/tmp/wl-')
const dataDir = join(tmp, 'data')
const project = join(tmp, 'project')
const inbox = join(tmp, 'inbox')
for (const d of [dataDir, project, inbox]) mkdirSync(d)
const socketPath = join(tmp, 'c.sock')

const failures = []
let app
let page

function report(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
  if (!ok) failures.push(name)
  return ok
}

const tmux = (...args) => spawnSync(TMUX, args, { encoding: 'utf8' })
const grab = () => tmux('capture-pane', '-p', '-t', `${TMUX_SESSION}:w0`, '-S', '-200').stdout ?? ''
const keys = (...k) => tmux('send-keys', '-t', `${TMUX_SESSION}:w0`, ...k)
const type = text => tmux('send-keys', '-t', `${TMUX_SESSION}:w0`, '-l', text)
const clearBox = async () => {
  for (let i = 0; i < 20; i++) keys('C-u')
  await sleep(400)
}

async function until(fn, timeoutMs, stepMs = 300) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    const v = await fn()
    if (v) return v
    await sleep(stepMs)
  }
  return false
}

function sock(method, path) {
  return new Promise((res, rej) => {
    const req = http.request({ socketPath, method, path, agent: false }, r => {
      const chunks = []
      r.on('data', c => chunks.push(c))
      r.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        res({ status: r.statusCode, body: text ? JSON.parse(text) : undefined })
      })
    })
    req.on('error', rej)
    req.end()
  })
}

const companion = (args, input) =>
  spawnSync('node', [join(ROOT, 'bin/agent-brief.mjs'), ...args], { encoding: 'utf8', input, env: { ...process.env, COMPANION_SOCKET: socketPath } })
const main$ = fn => app.evaluate(fn)
const visible = () => main$(() => globalThis.__companion.panel.isVisible())
const drafts = () =>
  readdirSync(join(dataDir, 'drafts'))
    .filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(readFileSync(join(dataDir, 'drafts', f), 'utf8')))
const shot = name => page.screenshot({ path: join(SHOTS, `${name}.png`) })
const selection = () => page.getByTestId('draft-body').evaluate(el => el.value.slice(el.selectionStart, el.selectionEnd))
const showStandalone = async () => {
  if (!(await visible())) await main$(() => globalThis.__companion.toggle())
  await sleep(300)
}

async function main() {
  if (!existsSync(join(ROOT, 'out/main'))) execFileSync('pnpm', ['build'], { cwd: ROOT, stdio: 'inherit' })
  app = await electron.launch({
    args: [ROOT],
    cwd: ROOT,
    env: { ...process.env, COMPANION_TEST: '1', COMPANION_DATA_DIR: dataDir, COMPANION_SOCKET: socketPath },
  })
  page = await app.firstWindow()
  await page.waitForFunction(() => !!window.__board?.api, undefined, { timeout: 30_000 })
  await until(async () => existsSync(socketPath) && (await sock('GET', '/health').catch(() => null))?.status === 200, 15_000)
  // Fill mode: drafts wait in the prompt box and never reach the model.
  await main$(() => globalThis.__companion.applySettings({ deliveryMode: 'fill' }))

  const settings = join(tmp, 'settings.json')
  writeFileSync(settings, JSON.stringify({ pluginConfigs: { 'agent-brief': { options: { companionSocket: socketPath, inboxDir: inbox } } } }))
  tmux('new-session', '-d', '-s', TMUX_SESSION, '-n', 'w0', '-x', '160', '-y', '50', '-c', project, `claude --plugin-dir ${MOD} --settings ${settings}`)
  const ready = await until(async () => {
    const text = grab()
    if (/Yes, I trust this folder/.test(text)) {
      keys('Down')
      await sleep(400)
      keys('Enter')
      return false
    }
    return /Try "|\? for shortcuts/.test(text)
  }, 60_000, 1000)
  report('0 claude started with the mod', Boolean(ready))
  if (!ready) return
  const registered = await until(async () => (await sock('GET', '/sessions')).body.sessions.length > 0, 20_000)
  report('0 session registered in the app', Boolean(registered))
  if (!registered) return

  // 1. Morning: a thought, captured with the shortcut, and nothing goes anywhere.
  await main$(() => globalThis.__companion.registrar.registered.get('Control+Alt+N')())
  await page.getByTestId('draft-body').waitFor()
  const focused = await page.getByTestId('draft-body').evaluate(el => el === document.activeElement)
  report('1 capture opens a focused, empty note', focused && (await page.getByTestId('draft-body').inputValue()) === '')
  await page.keyboard.type('iPad pairing fails on guest wifi? check with design')
  await shot('1-capture')
  await page.keyboard.press('Escape')
  const hid = await until(async () => !(await visible()), 3000)
  const saved = await until(() => drafts().some(d => d.body.startsWith('iPad pairing')), 3000)
  report('1 Escape hides the panel and the note is saved', Boolean(hid && saved))
  await sleep(1500)
  report('1 nothing reached Claude Code', !/iPad pairing/.test(grab()))

  // 2. Midday: two prompts from templates, queued.
  await showStandalone()
  await page.getByTestId('draft-new-menu').click()
  await page.getByTestId('new-menu-item').filter({ hasText: 'Bug report' }).click()
  await until(async () => (await selection()) === '{{what you saw}}', 3000)
  report('2 template opens with its first slot selected', (await selection()) === '{{what you saw}}')
  await page.keyboard.type('the panel forgets which board was open after an update')
  await page.keyboard.press('Tab')
  await page.keyboard.type('1. open board "checkout"\n2. install an update\n3. reopen the panel')
  await page.keyboard.press('Tab')
  await page.keyboard.type('the checkout board is still open')
  await page.keyboard.press('Meta+Shift+Enter')
  const body = page.getByTestId('draft-body')
  await page.getByTestId('draft-new').click()
  await body.pressSequentially('/plan')
  await page.keyboard.press('Enter')
  await until(async () => (await selection()) === '{{goal}}', 3000)
  await page.keyboard.type('add a Write mode export to markdown')
  await page.keyboard.press('Meta+Shift+Enter')
  const queue = await page.getByTestId('ready-list').getByTestId('draft-row').allTextContents()
  report('2 two drafts wait in Ready, in order', queue.length === 2 && /broken/.test(queue[0]) && /I want to/.test(queue[1]), queue.join(' | '))
  await shot('2-queue')
  await page.keyboard.press('Escape')
  await sleep(1500)
  report('2 still nothing in Claude Code', !/panel forgets/.test(grab()))

  // 3. Afternoon: send the first Ready draft. A standalone open asks where to go.
  await showStandalone()
  await page.getByTestId('ready-list').getByTestId('draft-row').first().click()
  await page.getByTestId('send').click()
  const asked = await page.getByTestId('send-chooser').isVisible()
  report('3 standalone Send asks for a session first', asked)
  await shot('3-chooser')
  await page.getByTestId('send-to-session').first().click()
  const landed = await until(() => /panel forgets which board/.test(grab()), 20_000, 500)
  const pane3 = grab()
  report('3 the written prompt lands in the prompt box', Boolean(landed))
  report('3 multi-line text arrives with its steps', /install an update/.test(pane3) && /still open/.test(pane3))
  report('3 no sketch reference in a text-only send', !/sketch\.png/.test(pane3))
  console.log(`--- pane (step 3) ---\n${pane3.trimEnd().split('\n').slice(-22).join('\n')}\n--- end pane ---`)
  report('3 the sent draft leaves the queue', drafts().filter(d => d.status === 'ready').length === 1)
  await clearBox()

  // 4. /sketch from Claude, draw, pull in the queued plan, Send.
  type('/sketch sketch the export flow')
  await sleep(800)
  keys('Enter')
  const sketching = await until(async () => (await page.getByTestId('mode-sketch').getAttribute('aria-selected')) === 'true' && (await visible()), 15_000)
  report('4 /sketch opens the panel in Sketch mode', Boolean(sketching))
  companion(['draw'], JSON.stringify({ elements: [{ id: 'a', type: 'rectangle', x: 0, y: 0, width: 200, height: 80, label: 'Export .md' }] }))
  await page.getByTestId('pull-in').click()
  await page.getByTestId('pull-in-item').filter({ hasText: 'I want to' }).click()
  await shot('4-pulled-in')
  report('4 the pulled-in draft shows next to the board', /I want to/.test(await page.getByTestId('pulled-draft').textContent()))
  await page.getByTestId('send').click()
  const both = await until(() => /add a Write mode export/.test(grab()) && /@\.feedback\/sketches\/[^\s/]+\/sketch\.png/.test(grab()), 20_000, 500)
  const pane4 = grab()
  report('4 prompt box gets the plan and the sketch', Boolean(both))
  const order = pane4.indexOf('add a Write mode export') < pane4.search(/@\.feedback\/sketches/)
  report('4 the written plan comes before the sketch line', order)
  console.log(`--- pane (step 4) ---\n${pane4.trimEnd().split('\n').slice(-16).join('\n')}\n--- end pane ---`)
  report('4 the queue is empty now', drafts().filter(d => d.status === 'ready').length === 0)
  await clearBox()

  // 5. A half-filled template is caught before it goes out.
  await showStandalone()
  await page.getByTestId('mode-write').click()
  await page.getByTestId('draft-new-menu').click()
  await page.getByTestId('new-menu-item').filter({ hasText: 'Feature' }).click()
  await until(async () => (await selection()) === '{{the feature}}', 3000)
  await page.keyboard.type('draft sharing')
  await page.getByTestId('send').click()
  await page.getByTestId('send-to-session').first().click().catch(() => undefined)
  const warned = await until(async () => /empty slots?\./.test((await page.getByTestId('send-status').textContent()) ?? ''), 5000)
  await shot('5-slot-warning')
  report('5 Send points out the empty slots', Boolean(warned), await page.getByTestId('send-status').textContent())
  await sleep(2000)
  report('5 nothing reached Claude Code', !/draft sharing/.test(grab()))

  // 6. History brings the morning's sent prompt back as a note.
  await page.getByTestId('history-toggle').click()
  await until(async () => (await page.getByTestId('history-item').count()) >= 2, 5000)
  const rows = await page.getByTestId('history-item').allTextContents()
  report('6 history lists both sends', rows.length === 2, rows.join(' | '))
  await page.getByTestId('history-item').filter({ hasText: 'Something is broken' }).getByTestId('history-open').click()
  const reopened = await until(async () => /panel forgets/.test(await page.getByTestId('draft-body').inputValue()), 5000)
  report('6 Open brings the sent text back as a note', Boolean(reopened))
  await shot('6-reopened')
}

try {
  await main()
} catch (err) {
  report('harness error', false, String(err?.stack ?? err))
}
if (failures.length > 0) console.log(`--- last pane ---\n${grab().trimEnd()}\n--- end pane ---`)
keys('C-u')
type('/exit')
await sleep(500)
keys('Enter')
await sleep(1500)
tmux('kill-session', '-t', TMUX_SESSION)
await app?.close().catch(() => undefined)
rmSync(tmp, { recursive: true, force: true })
console.log(failures.length === 0 ? 'ALL PASS' : `FAILED: ${failures.join('; ')}`)
process.exit(failures.length === 0 ? 0 : 1)
