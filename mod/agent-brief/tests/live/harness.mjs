/**
 * Shared pieces for the live tmux checks: a stub companion server, a real interactive
 * Claude Code session with this checkout's mod, and the keys that reach the band and panes.
 *
 * Focus facts, measured live:
 * - ctrl+x then Tab focuses the band. Band hotkeys (b, v, …) work only after that.
 * - Keyboard focus never reaches an inline pane. Tab cycles only the band's buttons.
 *   `click(text)` presses a pane button with an SGR mouse click instead.
 * - Focused buttons render in reverse video. `capture({ escapes: true })` keeps the codes.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export const MOD = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const COMPANION = process.env.COMPANION_DIR ?? resolve(MOD, '../../companion')
const ESBUILD = join(COMPANION, 'node_modules/.bin/esbuild')
const TMUX = process.env.TMUX_BIN ?? '/opt/homebrew/bin/tmux'

export const sleep = ms => new Promise(r => setTimeout(r, ms))

export async function until(fn, timeoutMs, stepMs = 300) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    const v = await fn()
    if (v) return v
    await sleep(stepMs)
  }
  return false
}

/** Bundles the app's real server and starts it with a minimal backend. */
export async function stubServer(tmp, socketPath, backend = {}) {
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
      ...backend,
    },
  })
  await server.listen()
  return server
}

/** A tmux session and the keys that drive it. `term.pane` holds the last capture. */
export function terminal(session) {
  const tmux = (...args) => spawnSync(TMUX, args, { encoding: 'utf8' })
  const term = {
    pane: '',
    tmux,
    capture: ({ escapes = false, lines = 60 } = {}) =>
      (term.pane = tmux('capture-pane', '-p', ...(escapes ? ['-e'] : []), '-t', session, ...(lines ? ['-S', `-${lines}`] : [])).stdout ?? ''),
    keys: (...k) => tmux('send-keys', '-t', session, ...k),
    type: text => tmux('send-keys', '-t', session, '-l', text),

    /** Starts claude with this checkout's mod and gets past the folder trust prompt. */
    async start({ cwd, cols = 117, rows = 50, args = '' }) {
      tmux('new-session', '-d', '-s', session, '-x', String(cols), '-y', String(rows), '-c', cwd, `claude --plugin-dir ${MOD} ${args}`)
      return until(async () => {
        term.capture()
        if (/Yes, I trust this folder/.test(term.pane)) {
          term.keys('Down')
          await sleep(400)
          term.keys('Enter')
          return false
        }
        return /Try "|\? for shortcuts/.test(term.pane)
      }, 60_000, 1000)
    },

    async focusBand() {
      term.keys('C-x')
      await sleep(200)
      term.keys('Tab')
      await sleep(600)
    },

    /** Presses a band button by its hotkey. */
    async pressBand(key) {
      await term.focusBand()
      term.keys(key)
    },

    /** Clicks the first visible occurrence of `text`, on a line that also holds `row` when given. Returns false when it isn't on screen. */
    async click(text, row = '') {
      const rowsShown = term.capture({ lines: 0 }).split('\n')
      const y = rowsShown.findIndex(l => l.includes(text) && l.includes(row))
      if (y < 0) return false
      const x = [...rowsShown[y].slice(0, rowsShown[y].indexOf(text))].length + 1
      term.type(`\x1b[<0;${x};${y + 1}M\x1b[<0;${x};${y + 1}m`)
      await sleep(400)
      return true
    },

    /** The text of the reverse-video run, which is the focused button. Empty when nothing is focused. */
    focused() {
      const screen = term.capture({ escapes: true, lines: 0 })
      const m = screen.match(/\x1b\[(?:[0-9]+;)*7m(.*?)\x1b\[(?:0|27)?m/)
      return m ? m[1].replace(/\x1b\[[0-9;]*m/g, '').trim() : ''
    },

    close: () => tmux('kill-session', '-t', session),
  }
  return term
}
