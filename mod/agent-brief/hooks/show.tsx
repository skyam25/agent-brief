import { atom, read, update } from 'claude-code'
import type { EngineInterface, ElementTable, On, RenderInput, RenderViewport } from 'claude-code'

import { fillRequest } from './companion-logic'
import {
  IMAGE_FILE,
  SVG_FILE,
  SVG_RASTER_WIDTH,
  UNCONFIRMED_NOTE,
  WIREFRAME_FILE,
  SHOW_PANE,
  SHOW_SECTION,
  SHOW_TOOL,
  SHOW_USAGE,
  baseName,
  cantDraw,
  causeOf,
  expandPath,
  expiredPrompt,
  markLine,
  noticeOf,
  pickText,
  pngSizeOf,
  requestedOf,
  showInstructions,
  shownOf,
  shownText,
  sizeFor,
  stemOf,
  terminalOf,
  thumbnailCrop,
  toolLine,
  viewBoxOf,
} from './show-logic'
import type { DrawCause, Requested, ShowNotice, Shown, ShownItem } from './show-logic'

/** The Open board button's key carries the board, so register.tsx can open it on `ui.press` with its own `$`. */
export const boardKey = (board: string) => `board:${board}`
export const boardOfKey = (key: string): string | undefined => (key.startsWith('board:') ? key.slice(6) : undefined)

/** Copies kept in `.feedback/shown`, newest first. */
const STORE_KEEP = 40

/** The narrowest a picture gets when several share a row. */
const SIDE_MIN_COLUMNS = 30

const shownRef = atom({ plugin: 'agent-brief', key: 'shown' } as const, null)

let cwd = ''
let home = ''
let sessionId = ''
let nodePath = 'node'
/** Whether rsvg-convert is on PATH; looked for once per session, again while missing. */
let hasRsvg: boolean | undefined
let generation = 0
let canImage = true
let isProbed = false
/** A transcript row's probe is waiting for its answer. */
let isRowProbing = false
let drawCause: DrawCause = 'background'
let terminal = ''
let inTmux = false
let inHerdr = false

/** How one transcript row or the pane shows its pictures. */
type View = {
  tab: number
  isSideBySide: boolean
  /** Scrolled out of view since it was last drawn. */
  wasAway?: boolean
  /** Back in view: send the pictures to the terminal again after drawing. */
  resend?: boolean
  /** The Image keys and sources drawn last, for that resend. */
  mounted?: { key: string; file: string }[]
}
const views = new Map<string, View>()
const viewOf = (site: string): View => {
  let one = views.get(site)
  if (!one) views.set(site, (one = { tab: 0, isSideBySide: false }))
  return one
}

/** Each failed show's notice, by tool call, for the box drawn in its place. */
const notices = new Map<string, ShowNotice>()

type Ui = ElementTable
type ImageElement = ElementTable<'terminal'>['Image'] | undefined
type Press = { surface: 'terminal' | 'desktop' | 'vscode' | 'mobile' }

function log($: EngineInterface, text: string): void {
  $.ui.log(`agent-brief: ${text}`, { to: 'debug' })
}

const redraw = ($: EngineInterface) => $.ui.invalidate('ui.render')

const exists = ($: EngineInterface, file: string) => $.fs.stat(file).then(() => true, () => false)

/** Gone only when the disk says so. */
const isGone = ($: EngineInterface, file: string) =>
  $.fs.stat(file).then(
    () => false,
    (e: unknown) => /ENOENT|not found|no such file/i.test(String((e as Error)?.message ?? e)),
  )

/** The project's folder for kept copies, or undefined when it cannot be made. */
async function storeDir($: EngineInterface): Promise<string | undefined> {
  const dir = `${cwd}/.feedback/shown`
  const r = await $.process.run(['mkdir', '-p', dir]).catch(() => undefined)
  return r && r.exitCode === 0 ? dir : undefined
}

/** Drops the oldest copies past STORE_KEEP. Best effort. */
function trimStore($: EngineInterface, dir: string): Promise<unknown> {
  return $.process
    .run(['sh', '-c', `ls -t "$0"/*.png 2>/dev/null | tail -n +$(( $1 + 1 )) | while read -r f; do rm -f "$f"; done; true`, dir, String(STORE_KEEP)])
    .catch(() => undefined)
}

/** A fresh name in the store for this show, with the extension given. */
async function storePath($: EngineInterface, dir: string, stem: string, ext: string): Promise<string> {
  generation += 1
  return `${dir}/${stem}-${Math.floor(await $.clock.now())}-${generation}${ext}`
}

/**
 * Turns an SVG into a PNG the terminal can draw: rsvg-convert where it is
 * installed, else a QuickLook thumbnail cropped back to the SVG's shape.
 */
async function rasterize($: EngineInterface, svg: string, png: string): Promise<void> {
  if (hasRsvg !== true) {
    const found = await $.process.run(['sh', '-c', 'command -v rsvg-convert']).catch(() => undefined)
    hasRsvg = found !== undefined && found.exitCode === 0
  }
  if (hasRsvg) {
    const r = await $.process.run(['rsvg-convert', '-w', String(SVG_RASTER_WIDTH), '--keep-aspect-ratio', svg, '-o', png])
    if (r.exitCode === 0) return
    throw new Error(`could not read ${svg}: ${r.stderr.trim().slice(0, 200)}`)
  }
  const dir = png.slice(0, png.lastIndexOf('/'))
  const thumb = await $.process.run(['qlmanage', '-t', '-s', String(SVG_RASTER_WIDTH), '-o', dir, svg]).catch(() => undefined)
  const made = `${dir}/${baseName(svg)}.png`
  if (!thumb || thumb.exitCode !== 0 || !(await exists($, made))) throw new Error(`no rasterizer for ${svg}`)
  const box = viewBoxOf(await $.fs.read(svg).catch(() => ''))
  const crop = thumbnailCrop(box ?? { width: 1, height: 1 }, SVG_RASTER_WIDTH)
  const cut = await $.process.run(['sips', '-c', String(crop.height), String(crop.width), '--cropOffset', '0', '0', made, '--out', png])
  if (cut.exitCode !== 0) throw new Error(`could not read ${svg}: ${cut.stderr.trim().slice(0, 200)}`)
  void $.process.run(['rm', '-f', made]).catch(() => undefined)
}

/** Renders a wireframe DSL file to SVG with the vendored wireframe-dsl renderer. A lint problem is the error's text, so Claude can fix the block. */
async function renderWireframe($: EngineInterface, source: string, svg: string): Promise<void> {
  const r = await $.process.run([nodePath, `${$.plugin.root}/bin/wireframe-render.mjs`, source, '--out', svg, '--strict'], { timeoutMs: 30_000 })
  if (r.exitCode !== 0 || !(await exists($, svg))) {
    throw new Error(`wireframe: ${(r.stderr.trim() || r.stdout.trim() || 'the renderer wrote nothing').replace(/^error:\s*/i, '')}`)
  }
}

/** The PNG's pixel size, from sips. */
async function pngSize($: EngineInterface, png: string, named: string): Promise<{ width: number; height: number }> {
  const dims = await $.process.run(['sips', '-g', 'pixelWidth', '-g', 'pixelHeight', png])
  const size = pngSizeOf(dims.stdout)
  if (!size) throw new Error(`not an image: ${named}`)
  return size
}

/**
 * Resolves what a call asks for to a PNG the terminal can draw. A file is
 * copied into `.feedback/shown`, converted with `sips` when it is not a PNG,
 * so the row keeps its picture after a temp folder is cleared. A wireframe
 * block or SVG text is written there, rendered and rasterized; the row's
 * source is then the SVG.
 */
async function prepareItem($: EngineInterface, r: Requested): Promise<ShownItem> {
  const dir = await storeDir($)
  if (r.wireframe !== undefined || r.svg !== undefined) {
    if (!dir) throw new Error(`could not convert ${r.title ?? 'the picture'}: .feedback/shown cannot be made in the project`)
    const stem = (r.title ?? (r.wireframe !== undefined ? 'wireframe' : 'picture')).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'picture'
    const svg = await storePath($, dir, stem, '.svg')
    if (r.wireframe !== undefined) {
      const source = svg.replace(/\.svg$/, '.wireframe')
      await $.fs.write(source, r.wireframe.endsWith('\n') ? r.wireframe : `${r.wireframe}\n`)
      await renderWireframe($, source, svg)
    } else {
      await $.fs.write(svg, r.svg!)
    }
    const png = svg.replace(/\.svg$/, '.png')
    await rasterize($, svg, png)
    return { path: png, source: svg, ...(await pngSize($, png, svg)), title: r.title ?? (r.wireframe !== undefined ? 'Wireframe' : baseName(svg)) }
  }
  const source = expandPath(r.path!, cwd, home)
  await $.fs.stat(source)
  if (WIREFRAME_FILE.test(source)) {
    if (!dir) throw new Error(`could not convert ${source}: .feedback/shown cannot be made in the project`)
    const svg = await storePath($, dir, stemOf(source), '.svg')
    await renderWireframe($, source, svg)
    const png = svg.replace(/\.svg$/, '.png')
    await rasterize($, svg, png)
    return { path: png, source: svg, ...(await pngSize($, png, svg)), title: r.title ?? stemOf(source) }
  }
  if (SVG_FILE.test(source)) {
    if (!dir) throw new Error(`could not convert ${source}: .feedback/shown cannot be made in the project`)
    const png = await storePath($, dir, stemOf(source), '.png')
    await rasterize($, source, png)
    return { path: png, source, ...(await pngSize($, png, source)), title: r.title ?? baseName(source) }
  }
  if (!IMAGE_FILE.test(source)) throw new Error(`not an image: ${source}`)
  const isPng = /\.png$/i.test(source)
  let path = source
  if (dir) {
    const copy = await storePath($, dir, stemOf(source), '.png')
    const made = isPng
      ? await $.process.run(['cp', source, copy])
      : await $.process.run(['sips', '-s', 'format', 'png', source, '--out', copy])
    if (made.exitCode === 0) path = copy
    else if (!isPng) throw new Error(`could not convert ${source}: ${made.stderr.trim()}`)
  } else if (!isPng) {
    throw new Error(`could not convert ${source}: .feedback/shown cannot be made in the project`)
  }
  return { path, source, ...(await pngSize($, path, source)), title: r.title ?? baseName(source) }
}

/** The key of the band's clear pixel, drawn until a probe settles whether pictures draw here. */
export const PROBE_KEY = 'picture-probe'

/** Whether pictures still need a probe. */
export const needsProbe = () => canImage && !isProbed

/**
 * Takes a probe's blit answer. Drawn, or drawing its alt, settles it; any
 * other refusal (not mounted yet) leaves it open. Returns whether it settled.
 */
export function noteProbe(deny: string | undefined): boolean {
  if (isProbed) return false
  if (deny && !/alt/i.test(deny)) return false
  isProbed = true
  if (deny) {
    canImage = false
    drawCause = causeOf(inTmux, terminal, inHerdr)
  }
  return true
}

/** After a first draw, asks whether the picture really drew; if the terminal only shows the alt text, every picture becomes a notice. */
function probe($: EngineInterface, site: string, key: string, file: string): void {
  if (!needsProbe() || isRowProbing) return
  isRowProbing = true
  void $.clock
    .sleep(250)
    .then(async () => {
      const r = await $.ui.blit({ requestId: site, key, source: { file, format: 'png' } })
      log($, `picture probe: ${r.deny ?? 'drew'}`)
      if (noteProbe(r.deny) && !canImage) {
        $.ui.toast("Pictures can't show here: see the notice in the chat.")
        redraw($)
      }
    })
    .catch(() => undefined)
    .finally(() => (isRowProbing = false))
}

/** Sends every picture of a site to the terminal again. A row scrolled back into view may have lost them. */
function resend($: EngineInterface, site: string): void {
  const view = viewOf(site)
  for (const m of view.mounted ?? []) {
    void $.ui.blit({ requestId: site, key: m.key, source: { file: m.file, format: 'png' } }).catch(() => undefined)
  }
}

/** A failure, drawn in place of the picture: what happened, and one button that copies what to paste back. */
function NoticeBox(ui: Ui, $: EngineInterface, width: number, n: { title: string; text: string; command?: string; copy: string; label: string }) {
  const { Box, Text, Button } = ui
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="warning" paddingX={2} paddingY={1} width={Math.max(40, Math.min(width, 96))}>
      <Text bold color="warning">
        ⚠ {n.title}
      </Text>
      <Text wrap="wrap">
        {'\n'}
        {n.text}
      </Text>
      {n.command ? (
        <Box marginTop={1}>
          <Text bold>{n.command}</Text>
        </Box>
      ) : null}
      <Box flexDirection="row" gap={2} marginTop={1}>
        <Button
          key="copy-notice"
          variant="primary"
          label={n.label}
          onPress={(press: Press) =>
            void $.ui
              .copy({ text: n.copy, surface: press.surface })
              .then(r => $.ui.toast(r.isCopied ? (n.command ? 'Copied. Paste it in your terminal.' : 'Copied. Paste it to Claude.') : 'Could not copy'))
          }
        />
      </Box>
    </Box>
  )
}

/** The buttons under a picture: open it, open its board, find it, copy its path. */
function Actions(ui: Ui, $: EngineInterface, shown: Shown, item: ShownItem) {
  const { Box, Button } = ui
  const done = (r: { exitCode: number }, note: string) => $.ui.toast(r.exitCode === 0 ? note : 'Could not open it')
  const page = shown.url ?? (/\.html?$/i.test(item.source) ? item.source : undefined)
  return (
    <Box flexDirection="row" columnGap={2} flexWrap="wrap">
      <Button
        key="open"
        plain
        label={page ? '↗ Open page' : '↗ Open'}
        onPress={() => void $.process.run(['open', page ?? item.source]).then(r => done(r, `Opened ${baseName(page ?? item.source).slice(0, 60)}`))}
      />
      {shown.board !== undefined && <Button key={boardKey(shown.board)} plain label="▦ Open board" onPress={() => undefined} />}
      <Button
        key="reveal"
        plain
        dimColor
        label="Show in Finder"
        onPress={() => void $.process.run(['open', '-R', item.source]).then(r => done(r, 'Shown in Finder'))}
      />
      <Button
        key="copy"
        plain
        dimColor
        label="Copy path"
        onPress={(press: Press) =>
          void $.ui.copy({ text: item.source, surface: press.surface }).then(r => $.ui.toast(r.isCopied ? 'Path copied' : 'Could not copy the path'))
        }
      />
    </Box>
  )
}

/** Puts the pick in the prompt box, after anything already typed, for the user to send. */
async function pick($: EngineInterface, shown: Shown, index: number): Promise<void> {
  try {
    const box = await $.prompt.read()
    const filled = await $.prompt.fill(fillRequest(box.text, pickText(shown, index)))
    $.ui.toast(filled.isFilled ? 'Your pick is in the prompt box — press Enter' : 'Could not fill the prompt box')
  } catch (err) {
    log($, `pick failed: ${String(err)}`)
    $.ui.toast('Could not fill the prompt box')
  }
}

/** The picture, or the options as tabs or side by side, with the buttons under it. */
async function Viewer(
  ui: Ui,
  Image: ImageElement,
  $: EngineInterface,
  site: string,
  shown: Shown,
  viewport: RenderViewport | undefined,
  isPane: boolean,
) {
  const { Box, Text, Button } = ui
  const view = viewOf(site)
  const columns = viewport?.columns ?? 100
  const rows = viewport?.rows ?? 40
  const room = columns - (isPane ? 6 : 10)
  const n = shown.items.length
  const hasOptions = n > 1
  const sideWidth = Math.floor((room - 2 * (n - 1)) / n)
  const canSide = hasOptions && sideWidth >= SIDE_MIN_COLUMNS
  const isSide = canSide && view.isSideBySide
  const tab = Math.min(view.tab, n - 1)
  const active = shown.items[tab]!

  if (!canImage) {
    const w = cantDraw(drawCause, shown.title, sessionId)
    return NoticeBox(ui, $, room, { ...w, copy: w.command })
  }
  for (const item of shown.items) {
    if (await isGone($, item.path)) {
      return NoticeBox(ui, $, room, {
        title: 'This picture has expired',
        text: `"${shown.title}" was cleared from the project's .feedback folder, and its file is no longer there. Copy the prompt and paste it to Claude to send it again.`,
        copy: expiredPrompt(shown),
        label: 'Copy prompt',
      })
    }
  }
  if (!Image) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="subtle" paddingX={1}>
        <Text bold>{shown.title}</Text>
        <Text dimColor>This surface cannot draw pictures. {shown.items.map(i => i.source).join(', ')}</Text>
      </Box>
    )
  }

  const picture = (item: ShownItem, key: string, width: number) => {
    const box = sizeFor(item.width, item.height, width, rows, isPane)
    return { box, element: <Image key={key} source={{ file: item.path, format: 'png' }} columns={box.columns} rows={box.rows} alt={`[image: ${item.title}]`} /> }
  }

  const tabs = hasOptions && (
    <Box flexDirection="row" columnGap={1} flexWrap="wrap">
      {shown.items.map((item, i) => (
        <Button
          key={`tab-${i}`}
          variant={!isSide && i === tab ? 'primary' : 'secondary'}
          label={`${i + 1} ${item.title}`}
          onPress={() => {
            view.tab = i
            view.isSideBySide = false
            redraw($)
          }}
        />
      ))}
      {canSide && (
        <Button
          key="side"
          variant={isSide ? 'primary' : 'secondary'}
          label="⧉ Side by side"
          onPress={() => {
            view.isSideBySide = !view.isSideBySide
            redraw($)
          }}
        />
      )}
    </Box>
  )

  let width: number
  let stage
  if (isSide) {
    const drawn = shown.items.map((item, i) => ({ item, i, ...picture(item, `view-${i}`, sideWidth) }))
    view.mounted = drawn.map(d => ({ key: `view-${d.i}`, file: d.item.path }))
    probe($, site, 'view-0', drawn[0]!.item.path)
    width = drawn.reduce((w, d) => w + d.box.columns, 0) + 2 * (n - 1)
    stage = (
      <Box flexDirection="row" columnGap={2} alignItems="flex-start">
        {drawn.map(d => (
          <Box key={`side-${d.i}`} flexDirection="column" width={d.box.columns}>
            <Text bold wrap="truncate-end">
              {d.i + 1} {d.item.title}
            </Text>
            {d.element}
            <Button key={`pick-${d.i}`} plain label={`✓ Pick ${d.i + 1}`} onPress={() => void pick($, shown, d.i)} />
          </Box>
        ))}
      </Box>
    )
  } else {
    const one = picture(active, 'view', room)
    view.mounted = [{ key: 'view', file: active.path }]
    probe($, site, 'view', active.path)
    width = one.box.columns
    stage = one.element
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="subtle" paddingX={1} width={Math.max(width, 40) + 4}>
      <Box flexDirection="row" justifyContent="space-between" gap={2}>
        <Text bold wrap="truncate-end">
          {shown.title}
        </Text>
        <Text dimColor>{isSide ? `${n} options` : `${active.width}×${active.height}`}</Text>
      </Box>
      {tabs}
      {stage}
      <Box flexDirection="row" columnGap={2} flexWrap="wrap">
        {hasOptions && !isSide && <Button key="pick" variant="primary" label={`✓ Pick ${tab + 1}`} onPress={() => void pick($, shown, tab)} />}
        {!isSide && Actions(ui, $, shown, active)}
      </Box>
    </Box>
  )
}

/** The picture elements for a drawing: the surface's table, and Image where the terminal has it. */
function tableOf($: EngineInterface, e: RenderInput): { ui: Ui; Image: ImageElement } {
  if (e.surface === 'terminal') {
    const ui = $.ui.resolve(e)
    return { ui, Image: ui.Image }
  }
  return { ui: $.ui.resolve(e), Image: undefined }
}

const OPTION_PROPERTIES = {
  path: { type: 'string', description: 'A picture file: absolute, or relative to the project. PNG, JPEG, WebP, GIF, TIFF, SVG or .wireframe.' },
  wireframe: { type: 'string', description: 'A wireframe DSL block, rendered here. The wireframe skill has the grammar.' },
  svg: { type: 'string', description: 'An SVG document, rendered here.' },
  title: { type: 'string', description: 'Short caption' },
}

const TOOL_INPUT = {
  type: 'object',
  properties: {
    ...OPTION_PROPERTIES,
    url: { type: 'string', description: 'The page the picture shows; adds an Open page button' },
    board: { type: 'string', description: 'The Agent Brief board the picture is of; adds an Open board button' },
    options: {
      type: 'array',
      minItems: 2,
      maxItems: 4,
      description: '2 to 4 pictures to choose between, as tabs and side by side, each with a Pick button. Each is a path, a wireframe or an svg with a title. Use instead of a single picture.',
      items: {
        type: 'object',
        properties: { ...OPTION_PROPERTIES, title: { type: 'string', description: 'The option’s name, a few words' } },
      },
    },
  },
}

/** What the session's start found out, from the plugin's one `session.start` hook. */
export type ShowEnvironment = {
  cwd: string
  home: string
  sessionId: string
  /** TERM_PROGRAM and TERM. */
  program: string
  term: string
  isTmux: boolean
  /** tmux answered `off` to allow-passthrough, so no picture can get through. */
  isPassthroughOff: boolean
  /** Inside a Herdr pane, where Claude Code draws no pictures. */
  isHerdr?: boolean
  /** The node that runs the wireframe renderer. */
  nodePath: string
}

/** Takes the session's environment. The engine refuses a second `session.start` hook, so register.tsx reads it and hands it here. */
export function startShow(env: ShowEnvironment): void {
  cwd = env.cwd
  home = env.home
  sessionId = env.sessionId
  nodePath = env.nodePath || 'node'
  hasRsvg = undefined
  terminal = terminalOf(env.program, env.term)
  inTmux = env.isTmux
  inHerdr = env.isHerdr === true
  canImage = !env.isPassthroughOff
  isProbed = env.isPassthroughOff
  drawCause = env.isPassthroughOff ? 'tmux' : 'background'
}

/** The tool as register.tsx registers it. */
export const SHOW_TOOL_SPEC = {
  name: 'show_image',
  description:
    "Shows a picture to the user, inline in their terminal. Accepts PNG, JPEG, WebP, GIF and TIFF.\n\n" +
    'Use it without being asked whenever you have made or changed something visual, before you say the work is done: screenshot a page or component with headless Playwright, or show a design, chart, board or generated image. ' +
    "Do this instead of asking the user to open a file or a localhost URL. Don't use it when nothing visual changed.\n\n" +
    'Pass `options` with 2 to 4 pictures to offer directions; the user switches between them, sees them side by side, and picks one with a button. ' +
    'Pass `board` when the picture is an Agent Brief board, and `url` when it is a page.\n\n' +
    "The picture goes to the user's screen, not to you. Read the file yourself only if you need to check it.",
  inputSchema: TOOL_INPUT,
  isDeferred: false as const,
}

export const SHOW_COMMAND_SPEC = { name: 'show', description: 'Show a picture in a pane: /show <path>', argumentHint: '<path>' }

/** The system prompt section for this session, when the tool is on offer. Called from the plugin's one `prompt.compose` hook. */
export function showSection(tools: readonly string[]): { id: string; scope: 'session'; text: string } | null {
  if (!tools.includes(SHOW_TOOL)) return null
  return { id: SHOW_SECTION, scope: 'session', text: showInstructions(canImage, drawCause, sessionId) }
}

/** The `show_image` tool, `/show`, and the picture drawn in the transcript or a pane. */
export function registerShow(on: On): void {
  on('tool.call', { tool: SHOW_TOOL }, async ($, e) => {
    const requested = requestedOf(e)
    if (typeof requested === 'string') return { deny: `show_image: ${requested}` }
    const input = e as { title?: unknown; url?: unknown; board?: unknown }
    let current: Requested = requested[0]!
    try {
      const items: ShownItem[] = []
      for (const r of requested) {
        current = r
        items.push(await prepareItem($, r))
      }
      const shown: Shown = {
        title: typeof input.title === 'string' && input.title ? input.title : items[0]!.title,
        items,
        ...(typeof input.url === 'string' && input.url ? { url: input.url } : {}),
        ...(typeof input.board === 'string' && input.board ? { board: input.board } : {}),
      }
      void storeDir($).then(dir => (dir ? trimStore($, dir) : undefined))
      const opening = !canImage
        ? `Not shown: ${cantDraw(drawCause, shown.title, sessionId).claude} Don't say it was shown.`
        : isProbed
          ? shownText(shown, cwd)
          : `${shownText(shown, cwd)} ${UNCONFIRMED_NOTE}`
      return { result: `${opening}\n${markLine(shown)}` }
    } catch (err) {
      const n = noticeOf(err, current.path !== undefined ? expandPath(current.path, cwd, home) : current.title ?? 'the wireframe', home)
      notices.set(e.tool_use_id, n)
      return { deny: `show_image: ${n.message}` }
    }
  }).catch(() => ({ deny: 'show_image: the picture could not be shown.' }))

  on('command.run', { command: 'show' }, async ($, e) => {
    const arg = e.args.trim()
    if (!arg) return { text: SHOW_USAGE }
    try {
      const item = await prepareItem($, { path: arg })
      const shown: Shown = { title: item.title, items: [item] }
      views.set(SHOW_PANE, { tab: 0, isSideBySide: false })
      await update($, shownRef, () => shown)
      await $.ui.open({ id: SHOW_PANE, title: item.title })
      return { text: `Showing ${item.title} (${item.width}×${item.height}).` }
    } catch (err) {
      return { text: noticeOf(err, expandPath(arg, cwd, home), home).message }
    }
  })

  // The call's own row: one short line, not the whole input.
  on('ui.render', { component: 'ToolUse' }, ($, e, next) => {
    const props = e.props as { tool: string; input: unknown; isRunning: boolean }
    if (props.tool !== SHOW_TOOL) return next(e)
    const { Text } = $.ui.resolve(e)
    return <Text>{toolLine(props.input, props.isRunning)}</Text>
  })

  // Inline in the transcript: the picture is the tool's result row.
  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    const props = e.props as { tool: string; tool_use_id: string; output: unknown; isErrored: boolean; onScreen?: unknown }
    if (props.tool !== SHOW_TOOL) return next(e)
    const { ui, Image } = tableOf($, e)
    const room = (e.viewport?.columns ?? 100) - 10
    if (props.isErrored) {
      const n = notices.get(props.tool_use_id)
      if (!n) return next(e)
      return NoticeBox(ui, $, room, { title: n.title, text: n.text, copy: n.prompt, label: 'Copy prompt' })
    }
    const shown = shownOf(props.output)
    if (!shown) return next(e)
    const view = viewOf(e.requestId)
    if (props.onScreen === null) view.wasAway = true
    else if (view.wasAway && props.onScreen) {
      view.wasAway = false
      view.resend = true
    }
    const tree = await Viewer(ui, Image, $, e.requestId, shown, e.viewport, false)
    if (view.resend) {
      view.resend = false
      void $.clock.sleep(120).then(() => resend($, e.requestId), () => undefined)
    }
    return tree
  })

  on('ui.render', { component: 'Pane', requestId: SHOW_PANE }, async ($, e) => {
    const { ui, Image } = tableOf($, e)
    const shown = await read($, shownRef)
    if (!shown) {
      const { Text } = ui
      return <Text dimColor>Nothing to show yet. Run /show path/to/file.png</Text>
    }
    return Viewer(ui, Image, $, SHOW_PANE, shown, e.viewport, true)
  })
}
