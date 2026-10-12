/** Pure helpers for `show_image`, `/show` and the picture drawn in the transcript. */

export const SHOW_TOOL = 'mcp__agent-brief__show_image'
export const SHOW_SECTION = 'agent-brief:show'
export const SHOW_PANE = 'agent-brief-show'
export const SHOW_USAGE = 'Usage: /show <path to a png, jpeg, webp, gif, tiff, svg or .wireframe>'

/** The tool result carries the drawing data after this prefix, on its own line. */
export const SHOW_MARK = 'agent-brief:show '

export const IMAGE_FILE = /\.(png|jpe?g|webp|gif|tiff?|heic)$/i
export const SVG_FILE = /\.svg$/i
export const WIREFRAME_FILE = /\.wireframe$/i

/** The pixel width an SVG is rasterized at; the height follows its viewBox. */
export const SVG_RASTER_WIDTH = 1600

/** The most pictures one call shows as options. */
export const MAX_OPTIONS = 4

/** Side by side needs this many columns for two pictures. */
export const SIDE_BY_SIDE_MIN = 100

/** One picture. `path` is the PNG the terminal reads; `source` is the file as the user knows it. */
export type ShownItem = {
  path: string
  source: string
  width: number
  height: number
  title: string
}

/** What the transcript row draws: one picture, or several options under one title. */
export type Shown = {
  title: string
  items: ShownItem[]
  url?: string
  board?: string
}

/** A typed or dragged-in path: quotes, backslash-escaped spaces and ~ allowed. */
export function expandPath(raw: string, cwd: string, home: string): string {
  let p = raw.trim().replace(/^(['"])(.*)\1$/, '$2').replace(/\\(.)/g, '$1')
  if (p === '~' || p.startsWith('~/')) p = home + p.slice(1)
  if (p.startsWith('/')) return p
  return `${cwd.replace(/\/$/, '')}/${p}`
}

export const baseName = (path: string) => path.split('/').pop() || path

/** The name without its extension. */
export const stemOf = (path: string) => baseName(path).replace(/\.[^.]+$/, '')

/** The path with the home folder shortened to ~, for text the user reads. */
export const shortPath = (path: string, home: string) => (home && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path)

/** Fits the picture in a box of cells. A cell is about twice as tall as wide. */
export function fit(width: number, height: number, maxCols: number, maxRows: number) {
  let columns = Math.max(1, Math.min(255, maxCols))
  let rows = Math.ceil((columns * height) / width / 2)
  if (rows > maxRows) {
    rows = maxRows
    columns = Math.max(1, Math.ceil((rows * 2 * width) / height))
  }
  return { columns: Math.min(255, columns), rows: Math.max(1, Math.min(255, rows)) }
}

/** The cell box for a picture given the room: at most 120 columns in a row, 220 in a pane, and a share of the screen's height. */
export function sizeFor(width: number, height: number, room: number, rows: number, isPane: boolean) {
  const maxCols = Math.max(Math.min(room, 24), Math.min(room, isPane ? 220 : 120))
  const maxRows = isPane ? Math.max(6, rows - 8) : Math.max(8, Math.min(40, Math.floor(rows * 0.55)))
  return fit(width, height, maxCols, maxRows)
}

/** A tool result's text, whether it came as a string, content blocks or a `{ result }` record. */
export function textOf(output: unknown): string {
  if (typeof output === 'string') return output
  if (Array.isArray(output)) {
    return output.map(b => (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : '')).join('\n')
  }
  if (output && typeof output === 'object' && typeof (output as { result?: unknown }).result === 'string') {
    return (output as { result: string }).result
  }
  return ''
}

export const markLine = (shown: Shown) => `${SHOW_MARK}${JSON.stringify(shown)}`

function itemOf(value: unknown): ShownItem | null {
  const v = (value ?? {}) as Partial<ShownItem>
  if (typeof v.path !== 'string' || typeof v.width !== 'number' || typeof v.height !== 'number') return null
  return {
    path: v.path,
    source: typeof v.source === 'string' ? v.source : v.path,
    width: v.width,
    height: v.height,
    title: typeof v.title === 'string' && v.title ? v.title : baseName(v.path),
  }
}

/** The drawing data in a tool result, or null when the result holds none. */
export function shownOf(output: unknown): Shown | null {
  const line = textOf(output)
    .split('\n')
    .find(l => l.startsWith(SHOW_MARK))
  if (!line) return null
  try {
    const value = JSON.parse(line.slice(SHOW_MARK.length)) as Partial<Shown>
    const items = (Array.isArray(value.items) ? value.items : []).map(itemOf).filter((i): i is ShownItem => i !== null)
    if (items.length === 0) return null
    return {
      title: typeof value.title === 'string' && value.title ? value.title : items[0]!.title,
      items,
      ...(typeof value.url === 'string' ? { url: value.url } : {}),
      ...(typeof value.board === 'string' ? { board: value.board } : {}),
    }
  } catch {
    return null
  }
}

/** The one line a show call's row reads while it runs and after. */
export function toolLine(input: unknown, isRunning: boolean): string {
  const i = (input ?? {}) as { path?: unknown; title?: unknown; options?: unknown; wireframe?: unknown; svg?: unknown }
  const count = Array.isArray(i.options) ? i.options.length : 0
  const what = typeof i.title === 'string' && i.title ? i.title : typeof i.path === 'string' ? baseName(i.path) : ''
  const kind = typeof i.wireframe === 'string' || (typeof i.path === 'string' && WIREFRAME_FILE.test(i.path)) ? 'wireframe' : 'image'
  const noun = count > 1 ? `${count} options` : kind === 'wireframe' ? 'Wireframe' : 'Image'
  return `▣ ${isRunning ? `Loading ${count > 1 ? noun : kind}` : noun}${what ? ` · ${what}` : ''}`
}

/** The size an SVG declares, from its viewBox or width and height. */
export function viewBoxOf(svg: string): { width: number; height: number } | null {
  const open = /<svg\b[^>]*>/i.exec(svg)?.[0] ?? ''
  const box = /viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)\s*["']/i.exec(open)
  if (box) return { width: Number(box[1]), height: Number(box[2]) }
  const w = /\swidth\s*=\s*["']([\d.]+)/i.exec(open), h = /\sheight\s*=\s*["']([\d.]+)/i.exec(open)
  return w && h ? { width: Number(w[1]), height: Number(h[1]) } : null
}

/** The crop that returns a square QuickLook thumbnail of `side` pixels to the SVG's shape. */
export function thumbnailCrop(box: { width: number; height: number }, side: number): { width: number; height: number } {
  if (box.width >= box.height) return { width: side, height: Math.max(1, Math.round((side * box.height) / box.width)) }
  return { width: Math.max(1, Math.round((side * box.width) / box.height)), height: side }
}

/** The text Claude reads back from a show. A rendered wireframe names its SVG so Claude can refer to it. */
export function shownText(shown: Shown, cwd = ''): string {
  const svgNote = (it: ShownItem) => (SVG_FILE.test(it.source) ? ` SVG at ${cwd && it.source.startsWith(`${cwd}/`) ? it.source.slice(cwd.length + 1) : it.source}.` : '')
  if (shown.items.length === 1) {
    const it = shown.items[0]!
    return `Shown: ${shown.title} (${it.width}×${it.height}).${svgNote(it)}`
  }
  const names = shown.items.map((it, i) => `${i + 1}. ${it.title}`).join(', ')
  return `Shown ${shown.items.length} options for ${shown.title}: ${names}. The user picks one by replying.`
}

/** What the Pick button puts in the prompt box. */
export const pickText = (shown: Shown, index: number) =>
  `Go with option ${index + 1} (${shown.items[index]?.title ?? ''}) for ${shown.title}.`

/** The pixel size from `sips -g pixelWidth -g pixelHeight`. */
export function pngSizeOf(stdout: string): { width: number; height: number } | null {
  const width = Number(/pixelWidth:\s*(\d+)/.exec(stdout)?.[1] ?? 0)
  const height = Number(/pixelHeight:\s*(\d+)/.exec(stdout)?.[1] ?? 0)
  return width > 0 && height > 0 ? { width, height } : null
}

/** One picture a call asks for: a file, a wireframe DSL block, or SVG text. */
export type Requested = { path?: string; wireframe?: string; svg?: string; title?: string }

const NEEDS_ONE = 'needs exactly one of path, wireframe or svg'

function requestOf(value: unknown): Requested | string {
  const v = (value ?? {}) as { path?: unknown; wireframe?: unknown; svg?: unknown; title?: unknown }
  const given: Requested[] = []
  if (typeof v.path === 'string' && v.path !== '') given.push({ path: v.path })
  if (typeof v.wireframe === 'string' && v.wireframe.trim() !== '') given.push({ wireframe: v.wireframe })
  if (typeof v.svg === 'string' && v.svg.trim() !== '') given.push({ svg: v.svg })
  if (given.length !== 1) return NEEDS_ONE
  return { ...given[0]!, ...(typeof v.title === 'string' && v.title ? { title: v.title } : {}) }
}

/** What a call names: one picture, or `options` of 2 to 4. */
export function requestedOf(input: unknown): Requested[] | string {
  const i = (input ?? {}) as { options?: unknown }
  if (Array.isArray(i.options) && i.options.length > 0) {
    if (i.options.length < 2) return 'options needs at least 2 pictures; pass one without options for a single picture.'
    if (i.options.length > MAX_OPTIONS) return `options takes at most ${MAX_OPTIONS} pictures.`
    const list: Requested[] = []
    for (const o of i.options) {
      const r = requestOf(o)
      if (typeof r === 'string') return `Each option ${r}.`
      list.push(r)
    }
    return list
  }
  const one = requestOf(input)
  return typeof one === 'string' ? `A picture ${one}.` : [one]
}

/**
 * A failure as the user and Claude see it. `text` is the box in the row,
 * `message` the line Claude reads, `prompt` what the Copy button gives the user to paste back.
 */
export type ShowNotice = { title: string; text: string; message: string; prompt: string }

export function noticeOf(err: unknown, path: string, home = ''): ShowNotice {
  const raw = String((err as Error)?.message ?? err)
  const shown = shortPath(path, home)
  const name = baseName(path)
  if (raw.startsWith('wireframe:')) {
    const detail = raw.slice('wireframe:'.length).trim().slice(0, 600)
    return {
      title: "The wireframe didn't render",
      text: detail,
      message: `The wireframe block did not render. ${detail}\nFix the block and show it again.`,
      prompt: `The wireframe didn't render (${detail.split('\n')[0]}). Fix the block and show it to me again.`,
    }
  }
  if (/no rasterizer/i.test(raw)) {
    return {
      title: 'SVG needs librsvg',
      text: `${name} is an SVG, and neither rsvg-convert nor QuickLook could turn it into a picture here. Install librsvg with \`brew install librsvg\`.`,
      message: `${shown} could not be rasterized: rsvg-convert is not installed and QuickLook failed. Ask the user to run \`brew install librsvg\` (you can run it for them), then show it again.`,
      prompt: `Install librsvg for me with \`brew install librsvg\`, then show the wireframe again.`,
    }
  }
  if (/not an image/i.test(raw)) {
    return {
      title: "This isn't a picture",
      text: `${name} isn't a picture, so it can't be shown. Pictures can be PNG, JPEG, WebP, GIF or TIFF.`,
      message: `${shown} isn't a picture (show_image opens PNG, JPEG, WebP, GIF and TIFF). Show an image file instead.`,
      prompt: `${shown} isn't a picture. Show me the right file instead.`,
    }
  }
  if (/could not convert|could not read|sips/i.test(raw)) {
    return {
      title: "This picture can't be read",
      text: `${name} couldn't be opened as a picture. It may be cut off, still being written, or not really an image.`,
      message: `${shown} couldn't be read as a picture. Re-export it, then show it again.`,
      prompt: `${shown} couldn't be read as a picture. Check it, re-export it if it's broken, then show it to me again.`,
    }
  }
  if (/ENOENT|no such file|not found/i.test(raw)) {
    return {
      title: 'File not found',
      text: `There's no file at ${shown}.`,
      message: `There's no file at ${shown}. Check the path (it may have moved or not been saved yet), then show it again.`,
      prompt: `There's no file at ${shown}. Find the right file and show it to me again.`,
    }
  }
  const detail = (raw.split('\n')[0] ?? '').slice(0, 160)
  return {
    title: "Couldn't show it",
    text: `${name} couldn't be shown: ${detail}`,
    message: `${shown} couldn't be shown: ${detail}`,
    prompt: `${shown} couldn't be shown (${detail}). Look into it and show it to me again.`,
  }
}

/** Why pictures can't draw here, once a draw has failed. */
export type DrawCause = 'tmux' | 'herdr' | 'terminal' | 'background'

export const causeOf = (isTmux: boolean, terminal: string, isHerdr = false): DrawCause =>
  isHerdr ? 'herdr' : isTmux ? 'tmux' : /^(ghostty|kitty)$/.test(terminal) ? 'background' : 'terminal'

/** A clear 1×1 PNG. The band draws it once to learn whether pictures draw here. */
export const CLEAR_PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII='

/** Added to a result sent before anything has drawn, so Claude doesn't claim the user saw it. */
export const UNCONFIRMED_NOTE = "This terminal hasn't drawn a picture yet, so it may show a notice instead. Don't say the user can see it."

/** The terminal's name from TERM_PROGRAM and TERM: ghostty, kitty, or the program in lower case. */
export function terminalOf(program: string, term: string): string {
  if (/ghostty/i.test(program + term)) return 'ghostty'
  if (/kitty/i.test(term)) return 'kitty'
  return program.toLowerCase() || 'other'
}

/** Resumes this chat outside the background service, so pictures draw again. */
export const resumeCommand = (sessionId: string) =>
  `CLAUDE_CODE_DISABLE_AGENT_VIEW=1 claude --resume${sessionId ? ` ${sessionId}` : ''}`

/** The notice for a picture that couldn't draw, and the line Claude reads. */
export function cantDraw(cause: DrawCause, name: string, sessionId: string) {
  if (cause === 'tmux') {
    return {
      title: 'tmux is blocking pictures',
      text: `"${name}" is ready, but tmux stops pictures from reaching the terminal. Add this line to ~/.tmux.conf, reload tmux, and ask Claude to show it again. Or open this chat outside tmux.`,
      command: 'set -g allow-passthrough on',
      label: 'Copy setting',
      claude: `tmux is blocking pictures, so the user saw a notice instead of ${name}. They can add "set -g allow-passthrough on" to ~/.tmux.conf or open the chat outside tmux.`,
    }
  }
  if (cause === 'herdr') {
    return {
      title: "Herdr can't show pictures",
      text: `"${name}" is ready, but Claude Code can't draw pictures inside a Herdr pane. Open this chat in a plain Ghostty tab to see it:`,
      command: `claude --resume${sessionId ? ` ${sessionId}` : ''}`,
      label: 'Copy command',
      claude: `Claude Code can't draw pictures inside a Herdr pane, so the user saw a notice instead of ${name}. They can resume the chat in a plain Ghostty tab to see it.`,
    }
  }
  if (cause === 'terminal') {
    return {
      title: "This terminal can't show pictures",
      text: `"${name}" is ready, but this terminal can't draw pictures. Open this chat in Ghostty to see it:`,
      command: `claude --resume${sessionId ? ` ${sessionId}` : ''}`,
      label: 'Copy command',
      claude: `this terminal can't draw pictures, so the user saw a notice instead of ${name}. They need Ghostty to see it.`,
    }
  }
  return {
    title: "Can't show pictures in a background session",
    text: `"${name}" is ready, but this chat is running as a background session, and those can't draw pictures in the terminal. Resume it in a normal Ghostty tab to see it:`,
    command: resumeCommand(sessionId),
    label: 'Copy command',
    claude: `this chat runs as a background session, which can't draw pictures, so the user saw a notice instead of ${name}. They can resume the chat in a normal terminal tab to see it.`,
  }
}

/** What the user pastes when a shown file has gone from disk. */
export function expiredPrompt(shown: Shown): string {
  const files = shown.items.map(i => i.source).join(', ')
  return `The picture "${shown.title}" expired (${files} gone). Please regenerate it and show it to me again with show_image.`
}

/** The system prompt section: show pictures while the terminal draws them; otherwise say nothing was seen. */
export function showInstructions(canImage: boolean, cause: DrawCause, sessionId: string): string {
  if (canImage) {
    return (
      'This terminal shows pictures inline. After visual work, screenshot it with headless Playwright and show it with show_image before you say you are done, instead of telling the user to open a file or a localhost URL. ' +
      'Show an Agent Brief board after you draw on it (agent-brief png, then show_image with board set), and show each screenshot you snap to a Stack board. ' +
      'For a UI fix, show before and after as two calls. To offer directions, pass 2 to 4 pictures as options; the user picks one with a button. ' +
      'A UI idea needs no file: pass a wireframe DSL block as `wireframe` (the wireframe skill has the grammar) and it renders inline. ' +
      'The picture goes to the user, not to you; Read the file yourself only if you need to check it.'
    )
  }
  const why = cantDraw(cause, 'it', sessionId).claude.replace(/, so the user saw a notice instead of it\./, '.')
  return `Pictures can't draw in this session (${why}) Anything shown with show_image was not seen: the user saw a notice instead. Don't say they saw it.`
}
