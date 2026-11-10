#!/usr/bin/env node
/**
 * Live check of the band in the Herdr app: two real interactive Claude Code sessions in tmux with this
 * checkout's mod, a stub companion server, a stub `hws`, and no model calls. Run by hand, never by
 * `claude plugin test`.
 *
 * The first session runs with the Herdr app's bundle id and a made-up terminal. Its band must show no
 * Stack and no iPad, and Sketch must run the stub with the surface flags. The second runs without them
 * and must show today's band. Both sessions get a temporary HOME whose ~/.local/bin/hws is the stub, so
 * the mod never reaches the real `hws`. That HOME has no ~/.claude, so no installed plugin loads and the
 * session is signed out, which the band does not need.
 *
 *   node tests/live/herdr-band.mjs            # 117 columns
 *   COLS=130 node tests/live/herdr-band.mjs
 */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { sleep, stubServer, terminal, until } from './harness.mjs'

const TERMINAL = 't-live-fake'
const tmp = mkdtempSync('/tmp/herdr-band-')
const project = join(tmp, 'demo-project')
const home = join(tmp, 'home')
const bin = join(tmp, 'bin')
const log = join(tmp, 'hws.log')
for (const dir of [project, join(tmp, 'inbox'), join(home, '.local/bin'), bin]) mkdirSync(dir, { recursive: true })

// One stub on PATH and in ~/.local/bin. Each run logs the path it ran from and its arguments.
const stub = `#!/bin/sh\nprintf '%s %s\\n' "$0" "$*" >> '${log}'\n[ "$1" = --help ] && echo usage\nexit 0\n`
for (const path of [join(home, '.local/bin/hws'), join(bin, 'hws')]) {
  writeFileSync(path, stub)
  chmodSync(path, 0o755)
}
// A minimal .claude.json skips onboarding.
writeFileSync(join(home, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, projects: { [project]: { hasTrustDialogAccepted: true } } }))

const socketPath = join(tmp, 's.sock')
const opens = []
const server = await stubServer(tmp, socketPath, {
  open: async req => {
    opens.push(req)
    return { board: 'main' }
  },
}, { ipad: { status: () => ({ paired: true }) } })
const settings = join(tmp, 'settings.json')
writeFileSync(settings, JSON.stringify({ pluginConfigs: { 'agent-brief': { options: { companionSocket: socketPath, inboxDir: join(tmp, 'inbox'), companionLaunch: '' } } } }))
const cols = process.env.COLS ?? 117
const logged = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [])

let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `: ${detail}`}`)
  if (!ok) failures++
}

/** Opens the band's picker: the band's focus starts on Brief, three steps back is the picker, and Down lists its options. */
async function openPicker(term) {
  await term.focusBand()
  for (let i = 0; i < 3; i++) {
    term.keys('BTab')
    await sleep(300)
  }
  term.keys('Down')
  await sleep(800)
  return term.capture().split('\n').filter(l => /Sketch|Write|Stack/.test(l)).join(' | ')
}

/** The band's row: the line holding Brief, with the line above when the picker wraps. */
const bandOf = pane => pane.split('\n').filter(l => /Brief|Sketch|Talk/.test(l)).join(' | ')

async function session(name, env) {
  const term = terminal(`herdr-band-${name}-${process.pid}`)
  const before = server.sessions().sessions.length
  await term.start({ cwd: project, cols, args: `--settings ${settings}`, env: { HOME: home, PATH: `${bin}:${process.env.PATH}`, ...env } })
  const registered = await until(() => server.sessions().sessions.length > before, 20_000)
  const drawn = await until(() => term.capture().includes('✎ Sketch'), 20_000)
  check(`${name}: claude started and registered`, Boolean(registered && drawn), term.pane.trimEnd().split('\n').slice(-10).join('\n'))
  await sleep(2500)
  term.capture()
  return term
}

try {
  // 1. In the Herdr app.
  const herdr = await session('herdr', { __CFBundleIdentifier: 'dev.herdr.app', HC_TERMINAL_ID: TERMINAL })
  const herdrBand = bandOf(herdr.pane)
  console.log(`--- Herdr band ---\n${herdrBand}\n---`)
  const checked = logged()
  check('herdr: the check ran ~/.local/bin/hws --help', checked.some(l => l === `${home}/.local/bin/hws --help`), checked.join('\n'))
  check('herdr: band shows Sketch, and no iPad', herdrBand.includes('✎ Sketch') && !herdrBand.includes('iPad'), herdrBand)

  // The picker's list shows its options. Stack must not be one of them.
  const listed = await openPicker(herdr)
  console.log(`--- Herdr picker open ---\n${listed}\n---`)
  check('herdr: picker lists Write and no Stack', listed.includes('¶ Write') && !listed.includes('Stack'), listed)

  // Enter picks the highlighted option. Down left the highlight on the second, Write, so Up comes back to Sketch.
  const pickOption = async (kind, name) => {
    const before = logged().length
    herdr.keys('Enter')
    const ran = await until(() => logged().slice(before).find(l => l.includes('surface open')), 10_000)
    check(
      `herdr: ${name} runs hws surface open for a ${kind} glued to the terminal`,
      ran === `${home}/.local/bin/hws surface open --type ${kind} --terminal ${TERMINAL}`,
      String(ran || logged().slice(before).join('\n') || 'no run'),
    )
  }
  herdr.keys('Up')
  await sleep(300)
  await pickOption('board', 'Sketch')
  check('herdr: Sketch asked the app for nothing', opens.length === 0, JSON.stringify(opens))
  herdr.close()
  await sleep(1000)

  // 2. The same setup without the Herdr variables.
  const runsBeforePlain = logged().length
  const plain = await session('plain', {})
  const plainBand = bandOf(plain.pane)
  console.log(`--- plain band ---\n${plainBand}\n---`)
  check('plain: band shows Sketch and iPad', plainBand.includes('✎ Sketch') && plainBand.includes('↗ iPad'), plainBand)
  const plainListed = await openPicker(plain)
  console.log(`--- plain picker open ---\n${plainListed}\n---`)
  check('plain: picker lists Stack', plainListed.includes('▤ Stack'), plainListed)
  plain.keys('Escape')
  await sleep(400)
  const plainRuns = logged().slice(runsBeforePlain)
  check('plain: the mod ran no hws', plainRuns.length === 0, plainRuns.join('\n'))
  plain.close()
  await sleep(2000)
  console.log(`--- hws log ---\n${logged().join('\n')}\n---`)
} finally {
  await server.close().catch(() => undefined)
  if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 })
}
if (failures > 0) process.exitCode = 1
