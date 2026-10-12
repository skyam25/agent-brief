import { atom, read, update } from 'claude-code'
import type { EngineInterface, ElementTable, On, RenderInput, RenderViewport } from 'claude-code'

import { fillRequest } from './companion-logic'
import { bashRequestOf } from './companion-protocol'
import {
  IMAGE_FILE,
  OPTIONS_TITLE,
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
  optionLetter,
  optionTitle,
  pickText,
  pngSizeOf,
  requestedOf,
  showInstructions,
  shownOf,
  shownText,
  sheetOf,
  sizeFor,
  stemOf,
  terminalOf,
  thumbnailCrop,
  toolLine,
  viewBoxOf,
} from './show-logic'
import type { DrawCause, Requested, ShowNotice, Shown, ShownItem, ShownSheet } from './show-logic'

/** The Open board button's key carries the board, so register.tsx can open it on `ui.press` with its own `$`. */
export const boardKey = (board: string) => `board:${board}`
export const boardOfKey = (key: string): string | undefined => (key.startsWith('board:') ? key.slice(6) : undefined)

/** Copies kept in `.feedback/shown`, newest first. */
const STORE_KEEP = 40

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
  /** The option drawn alone; unset draws the sheet. */
  focus?: number
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
  if (!one) views.set(site, (one = {}))
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
async function rasterize($: EngineInterface, svg: string, png: string, size = SVG_RASTER_WIDTH): Promise<void> {
  if (hasRsvg !== true) {
    const found = await $.process.run(['sh', '-c', 'command -v rsvg-convert']).catch(() => undefined)
    hasRsvg = found !== undefined && found.exitCode === 0
  }
  if (hasRsvg) {
    const r = await $.process.run(['rsvg-convert', '-w', String(size), '--keep-aspect-ratio', svg, '-o', png])
    if (r.exitCode === 0) return
    throw new Error(`could not read ${svg}: ${r.stderr.trim().slice(0, 200)}`)
  }
  const dir = png.slice(0, png.lastIndexOf('/'))
  const thumb = await $.process.run(['qlmanage', '-t', '-s', String(size), '-o', dir, svg]).catch(() => undefined)
  const made = `${dir}/${baseName(svg)}.png`
  if (!thumb || thumb.exitCode !== 0 || !(await exists($, made))) throw new Error(`no rasterizer for ${svg}`)
  const box = viewBoxOf(await $.fs.read(svg).catch(() => ''))
  const crop = thumbnailCrop(box ?? { width: 1, height: 1 }, size)
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

/** Lays the options out as one lettered PNG in the store, so they line up and draw as one picture. */
async function prepareSheet($: EngineInterface, items: ShownItem[]): Promise<ShownSheet> {
  const dir = await storeDir($)
  if (!dir) throw new Error('.feedback/shown cannot be made in the project')
  const cells = []
  for (const item of items) {
    const bytes = await $.fs.read(item.path, { as: 'bytes' })
    cells.push({ href: `data:image/png;base64,${bytes.base64}`, width: item.width, height: item.height, title: item.title })
  }
  const sheet = sheetOf(cells)
  const svg = await storePath($, dir, 'options', '.svg')
  await $.fs.write(svg, sheet.svg)
  const png = svg.replace(/\.svg$/, '.png')
  await rasterize($, svg, png, sheet.width)
  void $.process.run(['rm', '-f', svg]).catch(() => undefined)
  return { path: png, ...(await pngSize($, png, svg)) }
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

/** The picture, or the options as one lettered sheet with a tab for each, with the buttons under it. */
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
  const sheet = hasOptions ? shown.sheet : undefined
  const focus = view.focus !== undefined ? Math.min(view.focus, n - 1) : sheet ? undefined : 0
  const active = focus === undefined ? undefined : shown.items[focus]!
  const drawn: ShownItem = active ?? { ...sheet!, source: sheet!.path, title: shown.title }

  if (!canImage) {
    const w = cantDraw(drawCause, shown.title, sessionId)
    return NoticeBox(ui, $, room, { ...w, copy: w.command })
  }
  for (const file of [...shown.items.map(i => i.path), ...(sheet ? [sheet.path] : [])]) {
    if (await isGone($, file)) {
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

  const box = sizeFor(drawn.width, drawn.height, room, rows, isPane)
  view.mounted = [{ key: 'view', file: drawn.path }]
  probe($, site, 'view', drawn.path)

  const tabs = hasOptions && (
    <Box flexDirection="row" columnGap={1} flexWrap="wrap">
      {sheet && (
        <Button
          key="all"
          variant={focus === undefined ? 'primary' : 'secondary'}
          label="⧉ All"
          onPress={() => {
            view.focus = undefined
            redraw($)
          }}
        />
      )}
      {shown.items.map((item, i) => (
        <Button
          key={`tab-${i}`}
          variant={i === focus ? 'primary' : 'secondary'}
          label={`${optionLetter(i)} ${item.title}`}
          onPress={() => {
            view.focus = i
            redraw($)
          }}
        />
      ))}
    </Box>
  )

  const note = !hasOptions ? `${drawn.width}×${drawn.height}` : focus === undefined ? `${n} options` : `${optionLetter(focus)} of ${n}`
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="subtle" paddingX={1} width={Math.max(box.columns, 40) + 4}>
      <Box flexDirection="row" justifyContent="space-between" gap={2}>
        <Text bold wrap="truncate-end">
          {shown.title}
        </Text>
        <Text dimColor>{note}</Text>
      </Box>
      {tabs}
      <Image key="view" source={{ file: drawn.path, format: 'png' }} columns={box.columns} rows={box.rows} alt={`[image: ${drawn.title}]`} />
      <Box flexDirection="row" columnGap={2} flexWrap="wrap">
        {hasOptions && focus === undefined
          ? shown.items.map((_, i) => (
              <Button key={`pick-${i}`} variant="secondary" label={`✓ Pick ${optionLetter(i)}`} onPress={() => void pick($, shown, i)} />
            ))
          : hasOptions && <Button key="pick" variant="primary" label={`✓ Pick ${optionLetter(focus!)}`} onPress={() => void pick($, shown, focus!)} />}
        {focus !== undefined && Actions(ui, $, shown, drawn)}
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
      description: '2 to 4 pictures to choose between, drawn as one sheet lettered A to D, with a tab to see each alone and a Pick button for each. Each is a path, a wireframe or an svg with a title. Use instead of a single picture.',
      items: {
        type: 'object',
        properties: { ...OPTION_PROPERTIES, title: { type: 'string', description: 'The option’s name, a few words, without a letter or number; the sheet letters each option' } },
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
    'Pass `options` with 2 to 4 pictures to offer directions, and a `title` for the choice; they draw side by side as one sheet lettered A to D, and the user picks one with a button. ' +
    'Pass `board` when the picture is an Agent Brief board, and `url` when it is a page.\n\n' +
    "The picture goes to the user's screen, not to you. Read the file yourself only if you need to check it.",
  inputSchema: TOOL_INPUT,
  isDeferred: false as const,
}

export const SHOW_COMMAND_SPEC = { name: 'show', description: 'Show a picture in a pane: /show <path>', argumentHint: '<path>' }

/** Set when the engine refused to register show_image, as an organization's plugin policy does. */
let isToolRefused = false

export function noteShowToolRefused(isRefused: boolean): void {
  isToolRefused = isRefused
}

/**
 * The system prompt section for this session: for the show_image tool when it is on offer,
 * for `agent-brief show` when its registration was refused, else none.
 * Called from the plugin's one `prompt.compose` hook.
 */
export function showSection(tools: readonly string[]): { id: string; scope: 'session'; text: string } | null {
  const isCli = !tools.includes(SHOW_TOOL)
  if (isCli && !isToolRefused) return null
  return { id: SHOW_SECTION, scope: 'session', text: showInstructions(canImage, drawCause, sessionId, isCli) }
}

/**
 * Prepares what a show request names and answers with the text Claude reads,
 * the drawing data on its last line. A failure answers `{ deny }` with its notice.
 */
async function showFor($: EngineInterface, request: unknown): Promise<{ result: string } | { deny: string; notice?: ShowNotice }> {
  const requested = requestedOf(request)
  if (typeof requested === 'string') return { deny: `show_image: ${requested}` }
  const input = request as { title?: unknown; url?: unknown; board?: unknown }
  let current: Requested = requested[0]!
  try {
    const items: ShownItem[] = []
    for (const r of requested) {
      current = r
      const item = await prepareItem($, r)
      items.push(requested.length > 1 ? { ...item, title: optionTitle(item.title) } : item)
    }
    const sheet =
      items.length > 1
        ? await prepareSheet($, items).catch((err: unknown) => {
            log($, `options sheet: ${String(err)}`)
            return undefined
          })
        : undefined
    const shown: Shown = {
      title: typeof input.title === 'string' && input.title ? input.title : items.length > 1 ? OPTIONS_TITLE : items[0]!.title,
      items,
      ...(sheet ? { sheet } : {}),
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
    return { deny: `show_image: ${n.message}`, notice: n }
  }
}

/** The `show_image` tool, `/show`, and the picture drawn in the transcript or a pane. */
export function registerShow(on: On): void {
  on('tool.call', { tool: SHOW_TOOL }, async ($, e) => {
    const answer = await showFor($, e)
    if ('result' in answer) return answer
    if (answer.notice) notices.set(e.tool_use_id, answer.notice)
    return { deny: answer.deny }
  }).catch(() => ({ deny: 'show_image: the picture could not be shown.' }))

  // `agent-brief show` in Bash asks for the same picture. Its output becomes the show's result,
  // so the picture draws where a policy refuses the show_image tool.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const done = await next(e)
    const out = 'result' in done ? (done.result as { stdout?: unknown } | null | undefined) : undefined
    if (!out || typeof out.stdout !== 'string') return done
    const request = bashRequestOf(out.stdout)
    if (request?.kind !== 'show') return done
    const answer = await showFor($, request.input)
    const stdout = 'result' in answer ? answer.result : answer.deny
    return { result: { ...out, stdout }, ...(done.context ? { context: done.context } : {}) }
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'show' }, async ($, e) => {
    const arg = e.args.trim()
    if (!arg) return { text: SHOW_USAGE }
    try {
      const item = await prepareItem($, { path: arg })
      const shown: Shown = { title: item.title, items: [item] }
      views.set(SHOW_PANE, {})
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

  // The transcript folds shell commands into one count line, which hides an `agent-brief show` picture.
  // A group that holds one unfolds in place, so the picture draws without ctrl+o.
  on('ui.render', { component: 'ToolGroup' }, ($, e, next) => {
    const props = e.props as { calls: ReadonlyArray<{ tool: string; output?: unknown }>; isExpanded: boolean }
    if (props.isExpanded) return next(e)
    const hasShow = props.calls.some(c => c.tool === 'Bash' && shownOf(c.output) !== null)
    return hasShow ? next({ ...e, props: { ...e.props, isExpanded: true } } as typeof e) : next(e)
  })

  // Inline in the transcript: the picture is the tool's result row.
  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    const props = e.props as { tool: string; tool_use_id: string; output: unknown; isErrored: boolean; onScreen?: unknown }
    const isShow = props.tool === SHOW_TOOL || (props.tool === 'Bash' && shownOf(props.output) !== null)
    if (!isShow) return next(e)
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
