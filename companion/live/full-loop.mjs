#!/usr/bin/env node
/**
 * Full-loop live check: the real companion app (Electron, test mode, off screen),
 * the real feedback-inbox mod, and an interactive Claude Code in tmux.
 * Nothing is submitted to the model.
 *
 *   cd companion && node live/full-loop.mjs
 *
 * A second Claude session runs in a second tmux window to check routing.
 * FULL_LOOP_SECOND=0 skips it.
 */

import { _electron as electron } from '@playwright/test'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MOD = process.env.MOD_DIR ?? resolve(ROOT, '../mod/feedback-inbox')
const TMUX = process.env.TMUX_BIN ?? '/opt/homebrew/bin/tmux'
const TMUX_SESSION = `fullloop-${process.pid}`

const sleep = ms => new Promise(r => setTimeout(r, ms))
// Short paths keep the Unix socket under the OS path limit.
const tmp = mkdtempSync('/tmp/fl-')
const dataDir = join(tmp, 'data')
const project = join(tmp, 'project')
const project2 = join(tmp, 'project2')
const inbox = join(tmp, 'inbox')
for (const d of [dataDir, project, project2, inbox]) mkdirSync(d)
const WITH_SECOND = process.env.FULL_LOOP_SECOND !== '0'
const socketPath = join(tmp, 'c.sock')

const failures = []
let app
let pane = ''

function report(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
  if (!ok) failures.push(name)
  return ok
}

const tmux = (...args) => spawnSync(TMUX, args, { encoding: 'utf8' })
// Windows are named w0 (first Claude session) and w1 (second), so the user's tmux base-index does not matter.
const win = n => `${TMUX_SESSION}:w${n}`
const grab = (n = 0) => tmux('capture-pane', '-p', '-t', win(n), '-S', '-200').stdout ?? ''
const capture = () => (pane = grab(0))
const keys = (...k) => tmux('send-keys', '-t', win(0), ...k)
const type = text => tmux('send-keys', '-t', win(0), '-l', text)

/** Waits for a Claude window to reach its prompt, answering the trust prompt. */
const untilReady = n =>
  until(async () => {
    const text = grab(n)
    if (/Yes, I trust this folder/.test(text)) {
      tmux('send-keys', '-t', win(n), 'Down')
      await sleep(400)
      tmux('send-keys', '-t', win(n), 'Enter')
      return false
    }
    return /Try "|\? for shortcuts/.test(text)
  }, 60_000, 1000)

async function until(fn, timeoutMs, stepMs = 300) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    const v = await fn()
    if (v) return v
    await sleep(stepMs)
  }
  return false
}

/** One request over the app's Unix socket. */
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

function companion(args, input) {
  return spawnSync('node', [join(ROOT, 'bin/companion.mjs'), ...args], {
    encoding: 'utf8',
    input,
    env: { ...process.env, COMPANION_SOCKET: socketPath },
  })
}

function clearBox() {
  for (let i = 0; i < 12; i++) keys('C-u')
}

async function main() {
  // 1. The real app, in test mode.
  if (!existsSync(join(ROOT, 'out/main'))) execFileSync('pnpm', ['build'], { cwd: ROOT, stdio: 'inherit' })
  app = await electron.launch({
    args: [ROOT],
    cwd: ROOT,
    env: { ...process.env, COMPANION_TEST: '1', COMPANION_DATA_DIR: dataDir, COMPANION_SOCKET: socketPath },
  })
  const page = await app.firstWindow()
  await page.waitForFunction(() => !!window.__board?.api, undefined, { timeout: 30_000 })
  const up = await until(async () => existsSync(socketPath) && (await sock('GET', '/health').catch(() => null))?.status === 200, 15_000)
  report('1 app running in test mode', Boolean(up))
  if (!up) return

  // 2. Claude Code with the mod, pointed at this socket and an empty inbox.
  const settings = join(tmp, 'settings.json')
  writeFileSync(
    settings,
    JSON.stringify({ pluginConfigs: { 'feedback-inbox': { options: { companionSocket: socketPath, inboxDir: inbox } } } }),
  )
  const claude = `claude --plugin-dir ${MOD} --settings ${settings}`
  tmux('new-session', '-d', '-s', TMUX_SESSION, '-n', 'w0', '-x', '160', '-y', '50', '-c', project, claude)
  const ready = await untilReady(0)
  report('2 claude started with the mod', Boolean(ready))
  if (!ready) return

  // 3. The session shows in the app.
  const sessions = await until(async () => (await sock('GET', '/sessions')).body.sessions.length > 0, 20_000)
  const info = (await sock('GET', '/sessions')).body.sessions[0]
  report('3 session registered in the app', Boolean(sessions), info ? `${info.sessionId} ${info.cwd}` : '')
  if (!sessions) return
  const sessionId = info.sessionId

  // 4. /sketch shows its prompt in the panel and picks this session.
  type('/sketch draw the login flow')
  await sleep(800)
  keys('Enter')
  const prompted = await until(
    async () => (await page.getByTestId('prompt').textContent().catch(() => '')).includes('draw the login flow'),
    15_000,
  )
  report('4 panel shows the /sketch prompt', Boolean(prompted))
  const target = (await sock('GET', '/sessions')).body.targetSessionId
  const chip = await page.getByTestId('target-chip').textContent().catch(() => '')
  report('4 session is the Send target', target === sessionId && chip.startsWith('→'), `target=${target} chip=${chip}`)

  // 5. The CLI draws and reads.
  const drawn = companion(
    ['draw'],
    JSON.stringify({
      elements: [
        { id: 'a', type: 'rectangle', x: 0, y: 0, width: 200, height: 80, label: 'Login', color: 'blue' },
        { id: 'b', type: 'rectangle', x: 300, y: 0, width: 200, height: 80, label: 'Home', color: 'green' },
        { type: 'arrow', start: { id: 'a' }, end: { id: 'b' } },
      ],
    }),
  )
  report('5 companion draw exits 0', drawn.status === 0, (drawn.stderr || drawn.stdout).trim().slice(0, 120))
  const read = companion(['read'])
  const out = read.stdout
  report('5 companion read lists both boxes and the arrow', read.status === 0 && /Login/.test(out) && /Home/.test(out) && /arrow/i.test(out))
  console.log(out.trimEnd().split('\n').map(l => `    ${l}`).join('\n'))

  // 6. Send fills the prompt box and writes the bundle.
  await page.getByTestId('send').click()
  const filled = await until(() => /@\.feedback\/sketches\/[^\s/]+\/sketch\.png/.test(capture()), 20_000, 500)
  report('6 prompt box shows the @sketch.png draft', Boolean(filled))
  console.log(`--- pane (step 6) ---\n${pane.trimEnd()}\n--- end pane ---`)
  const id = /@\.feedback\/sketches\/([^\s/]+)\/sketch\.png/.exec(pane)?.[1]
  const dir = id ? join(project, '.feedback/sketches', id) : ''
  const present = id ? readdirSync(dir) : []
  report('6 bundle files exist in the project', present.includes('sketch.png') && present.includes('board.excalidraw'), present.join(', '))
  const png = id && present.includes('sketch.png') ? readFileSync(join(dir, 'sketch.png')) : undefined
  const inked = png
    ? await page.evaluate(async b64 => {
        const img = new Image()
        img.src = `data:image/png;base64,${b64}`
        await img.decode()
        const c = document.createElement('canvas')
        c.width = img.width
        c.height = img.height
        const ctx = c.getContext('2d')
        ctx.drawImage(img, 0, 0)
        const d = ctx.getImageData(0, 0, c.width, c.height).data
        let n = 0
        for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 0 && (d[i] < 245 || d[i + 1] < 245 || d[i + 2] < 245)) n++
        return { n, w: c.width, h: c.height }
      }, png.toString('base64'))
    : { n: 0, w: 0, h: 0 }
  report('6 sketch.png has non-white pixels', inked.n > 0, `${inked.n} of ${inked.w}x${inked.h}`)

  // 6b. A second session gets only what is sent to it.
  if (WITH_SECOND) {
    tmux('new-window', '-t', TMUX_SESSION, '-n', 'w1', '-c', project2, claude)
    const ready2 = await untilReady(1)
    const two = await until(async () => (await sock('GET', '/sessions')).body.sessions.length === 2, 20_000)
    report('6b second session registered', Boolean(ready2 && two))
    if (ready2 && two) {
      const other = (await sock('GET', '/sessions')).body.sessions.find(s => s.sessionId !== sessionId)
      // Send hid the panel; a standalone open asks where to send, and picking a session sends.
      await app.evaluate(() => globalThis.__companion.toggle())
      await page.getByTestId('send').click()
      await page.getByTestId('send-to-session').filter({ hasText: 'project2' }).click()
      const retargeted = await until(async () => (await sock('GET', '/sessions')).body.targetSessionId === other.sessionId, 5_000)
      report('6b Send to… picks the second session', Boolean(retargeted))
      const hit = await until(() => /@\.feedback\/sketches\/[^\s/]+\/sketch\.png/.test(grab(1)), 20_000, 500)
      const id2 = /@\.feedback\/sketches\/([^\s/]+)\/sketch\.png/.exec(grab(1))?.[1]
      report('6b second session box shows the new draft', Boolean(hit), id2)
      console.log(`--- pane (second session) ---\n${grab(1).trimEnd()}\n--- end pane ---`)
      await sleep(3000)
      const first = grab(0)
      report('6b first session box did not get it', Boolean(id2) && !first.includes(id2) && first.includes(id))
      report(
        '6b bundle written only under the second project',
        Boolean(id2) && existsSync(join(project2, '.feedback/sketches', id2)) && !existsSync(join(project, '.feedback/sketches', id2)),
      )
      for (let i = 0; i < 12; i++) tmux('send-keys', '-t', win(1), 'C-u')
      await sleep(300)
      tmux('send-keys', '-t', win(1), '-l', '/exit')
      await sleep(800)
      tmux('send-keys', '-t', win(1), 'Enter')
      const one = await until(async () => (await sock('GET', '/sessions')).body.sessions.length === 1, 20_000)
      report('6b second session removed after /exit', Boolean(one))
    }
  }

  // 7. Clean exit removes the session.
  clearBox()
  await sleep(500)
  type('/exit')
  await sleep(800)
  keys('Enter')
  const gone = await until(async () => (await sock('GET', '/sessions')).body.sessions.length === 0, 20_000)
  report('7 session removed from the app after /exit', Boolean(gone))
}

try {
  await main()
} catch (err) {
  report('harness error', false, String(err?.stack ?? err))
}
if (failures.length > 0) console.log(`--- last pane ---\n${capture().trimEnd()}\n--- end pane ---`)
tmux('kill-session', '-t', TMUX_SESSION)
await app?.close().catch(() => undefined)
rmSync(tmp, { recursive: true, force: true })
console.log(failures.length === 0 ? 'ALL PASS' : `FAILED: ${failures.join('; ')}`)
process.exit(failures.length === 0 ? 0 : 1)
