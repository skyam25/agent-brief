import { describe, expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { SHOW_TOOL, fit, optionTitle, requestedOf, sheetOf, shownOf, sizeFor, thumbnailCrop, toolLine, viewBoxOf } from '../hooks/show-logic'
import { bashRequestLine } from '../hooks/companion-protocol'
import { BAND, COMPOSE, CWD, SESSION, command, textOf, worldOf } from './world'
import type { World } from './world'

const SHOT = `${CWD}/shots/page.png`
const SHOT_B = `${CWD}/shots/page-b.png`
const JPEG = `${CWD}/shots/photo.jpg`
const STORE = `${CWD}/.feedback/shown`
const VIEWPORT = { columns: 120, rows: 40, isFullscreen: true }

/** sips reports a size, cp and sips conversions land in the store. */
function answerPictures(world: World & { hasRsvg: boolean }, size = '1440x900') {
  const [w, h] = size.split('x')
  world.answer = argv => {
    if (argv[0] === 'sips' && argv[1] === '-g') return { exitCode: 0, stdout: `${argv.at(-1)}\n  pixelWidth: ${w}\n  pixelHeight: ${h}\n`, stderr: '' }
    if (argv[0] === 'sips' && argv[1] === '-s') {
      world.files.set(argv.at(-1)!, 'png')
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    if (argv[0] === 'cp') {
      world.files.set(argv[2]!, world.files.get(argv[1]!) ?? 'png')
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    if (argv[1]?.endsWith('/bin/wireframe-render.mjs')) {
      const dsl = world.files.get(argv[2]!) ?? ''
      if (dsl.includes('\t')) return { exitCode: 1, stdout: '', stderr: 'error: wireframe did not parse: Line 3: tabs are not allowed; use 2 spaces per indent level.\n' }
      world.files.set(argv[4]!, '<svg viewBox="0 0 924 302" xmlns="http://www.w3.org/2000/svg"></svg>')
      return { exitCode: 0, stdout: `wrote ${argv[4]}\n`, stderr: '' }
    }
    if (argv[0] === 'sh' && argv[2] === 'command -v rsvg-convert') return { exitCode: world.hasRsvg ? 0 : 1, stdout: world.hasRsvg ? '/opt/homebrew/bin/rsvg-convert\n' : '', stderr: '' }
    if (argv[0] === 'rsvg-convert') {
      world.files.set(argv.at(-1)!, 'png')
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    if (argv[0] === 'qlmanage') {
      world.files.set(`${argv[5]}/${argv[6]!.split('/').pop()}.png`, 'png')
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    if (argv[0] === 'sips' && argv[1] === '-c') {
      world.files.set(argv.at(-1)!, 'png')
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
}

/**
 * How the band's clear pixel answers: it drew, it drew its alt, or the band
 * never drew. Pictures are known to draw by default.
 */
type Probe = 'drew' | 'alt' | 'none'

async function setup(
  $: Parameters<TestBody>[0],
  on: Parameters<TestBody>[1],
  files: Record<string, string> = { [SHOT]: 'png' },
  { probe = 'drew', env = {}, isToolRefused = false }: { probe?: Probe; env?: Record<string, string>; isToolRefused?: boolean } = {},
) {
  const world = worldOf(on, files) as World & { hasRsvg: boolean }
  world.env = env
  world.isToolRefused = isToolRefused
  on('ui.blit', () => (probe === 'alt' ? { value: { deny: 'the Image draws its alt here: the terminal draws no placeholder images' } } : { value: {} }))
  world.hasRsvg = true
  answerPictures(world)
  const clock = mock.clock(on)
  mock.store(on)
  const box = { text: '' }
  const opened: string[] = []
  on('prompt.read', () => ({ value: { text: box.text, cursor: box.text.length } }))
  on('prompt.fill', ($, e) => {
    box.text = e.mode === 'replace' ? e.text : box.text + e.text
    return { isFilled: true }
  })
  on('ui.open', ($, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  await $.session.start(SESSION)
  if (probe !== 'none') {
    await $.ui.render(BAND)
    await clock.advance(250)
  }
  return { world, clock, box, opened }
}

const DSL = 'layout: single\nframe: panel\nbody:\n  - heading: "Hi"\n'

const call = ($: Parameters<TestBody>[0], input: Record<string, unknown>) =>
  $.tool.call({ tool: SHOW_TOOL, tool_use_id: 't1', ...input } as never) as Promise<{ result?: string; deny?: string }>

const resultRow = (output: unknown, isErrored = false) => ({
  plugin: 'agent-brief',
  surface: 'terminal' as const,
  component: 'ToolResult' as const,
  requestId: 't1',
  viewport: VIEWPORT,
  props: { tool_use_id: 't1', tool: SHOW_TOOL, output, isErrored },
})

describe('fitting a picture to cells', () => {
  test('keeps the aspect with cells twice as tall as wide, within the caps', () => {
    expect(fit(1440, 900, 120, 40)).toEqual({ columns: 120, rows: 38 })
    expect(fit(1440, 900, 120, 20)).toEqual({ columns: 64, rows: 20 })
    expect(fit(100, 2000, 120, 30)).toEqual({ columns: 3, rows: 30 })
    expect(fit(4000, 10, 400, 40)).toEqual({ columns: 255, rows: 1 })
  })

  test('fills the width until the card would not fit on one screen', () => {
    expect(sizeFor(3000, 600, 180, 50, false)).toEqual({ columns: 180, rows: 18 })
    expect(sizeFor(1440, 900, 250, 70, false)).toEqual({ columns: 186, rows: 58 })
    expect(sizeFor(1440, 900, 200, 40, false)).toEqual({ columns: 90, rows: 28 })
    expect(sizeFor(1440, 900, 200, 40, true)).toEqual({ columns: 103, rows: 32 })
    expect(sizeFor(1440, 900, 12, 40, false).columns).toBe(12)
  })
})

describe('an SVG', () => {
  test('declares its size by viewBox, else width and height', () => {
    expect(viewBoxOf('<svg viewBox="0 0 924 302" xmlns="x">')).toEqual({ width: 924, height: 302 })
    expect(viewBoxOf('<svg width="400" height="300">')).toEqual({ width: 400, height: 300 })
    expect(viewBoxOf('<p>no</p>')).toBeNull()
  })

  test('a square thumbnail crops back to its shape', () => {
    expect(thumbnailCrop({ width: 924, height: 302 }, 1600)).toEqual({ width: 1600, height: 523 })
    expect(thumbnailCrop({ width: 300, height: 600 }, 1600)).toEqual({ width: 800, height: 1600 })
  })
})

describe('what a call asks for', () => {
  test('path alone, or 2 to 4 options', () => {
    expect(requestedOf({ path: 'a.png', title: 'A' })).toEqual([{ path: 'a.png', title: 'A' }])
    expect(requestedOf({ options: [{ path: 'a.png' }, { path: 'b.png', title: 'B' }] })).toEqual([{ path: 'a.png' }, { path: 'b.png', title: 'B' }])
    expect(requestedOf({})).toBe('A picture needs exactly one of path, wireframe or svg.')
    expect(requestedOf({ path: 'a.png', svg: '<svg/>' })).toBe('A picture needs exactly one of path, wireframe or svg.')
    expect(requestedOf({ wireframe: 'layout: single', title: 'W' })).toEqual([{ wireframe: 'layout: single', title: 'W' }])
    expect(requestedOf({ options: [{ path: 'a.png' }] })).toBe('options needs at least 2 pictures; pass one without options for a single picture.')
    expect(requestedOf({ options: [{}, { path: 'b.png' }] })).toBe('Each option needs exactly one of path, wireframe or svg.')
    expect(typeof requestedOf({ options: Array(5).fill({ path: 'a.png' }) })).toBe('string')
  })

  test('the call row reads one line', () => {
    expect(toolLine({ path: '/x/page.png' }, true)).toBe('▣ Loading image · page.png')
    expect(toolLine({ path: '/x/page.png', title: 'Pricing' }, false)).toBe('▣ Image · Pricing')
    expect(toolLine({ title: 'Hero', options: [{ path: 'a' }, { path: 'b' }, { path: 'c' }] }, false)).toBe('▣ 3 options · Hero')
  })
})

describe('show_image', () => {
  test('copies the picture into .feedback/shown and answers one line plus the mark', async ($, on) => {
    const { world } = await setup($, on)
    const reply = await call($, { path: 'shots/page.png', title: 'Pricing page', url: 'http://localhost:3000/pricing' })
    expect(reply.result?.split('\n')[0]).toBe('Shown: Pricing page (1440×900).')
    const shown = shownOf(reply.result)
    expect(shown).toMatchObject({ title: 'Pricing page', url: 'http://localhost:3000/pricing' })
    expect(shown?.items[0]).toMatchObject({ source: SHOT, width: 1440, height: 900, title: 'Pricing page' })
    expect(shown?.items[0]?.path.startsWith(`${STORE}/page-`)).toBe(true)
    expect(world.files.has(shown!.items[0]!.path)).toBe(true)
    const made = world.runs.find(r => r.argv[0] === 'sh' && r.argv[3] === `${CWD}/.feedback`)
    expect(made?.argv[2]).toContain('mkdir -p "$0/shown"')
    expect(made?.argv[2]).toContain(`printf '*\\n' > "$0/.gitignore"`)
  })

  test('converts a jpeg with sips', async ($, on) => {
    const { world } = await setup($, on, { [JPEG]: 'jpg' })
    const reply = await call($, { path: JPEG })
    const shown = shownOf(reply.result)
    expect(shown?.items[0]?.path.endsWith('.png')).toBe(true)
    expect(world.runs.some(r => r.argv[0] === 'sips' && r.argv[1] === '-s' && r.argv[4] === JPEG)).toBe(true)
  })

  test('a missing file is refused with a line Claude can act on', async ($, on) => {
    await setup($, on)
    const reply = await call($, { path: 'shots/gone.png' })
    expect(reply.deny).toBe(`show_image: There's no file at ${CWD}/shots/gone.png. Check the path (it may have moved or not been saved yet), then show it again.`)
  })

  test('a file that is not a picture is refused', async ($, on) => {
    await setup($, on, { [`${CWD}/notes.md`]: '# hi' })
    const reply = await call($, { path: 'notes.md' })
    expect(reply.deny).toContain("isn't a picture")
  })

  test('options become one shown with every item and a lettered sheet', async ($, on) => {
    const { world } = await setup($, on, { [SHOT]: 'png', [SHOT_B]: 'png' })
    const reply = await call($, { title: 'Hero', options: [{ path: SHOT, title: 'A · Bold' }, { path: SHOT_B, title: 'Quiet' }] })
    expect(reply.result?.split('\n')[0]).toBe('Shown 2 options for Hero: A. Bold, B. Quiet. The user picks one by replying.')
    const shown = shownOf(reply.result)!
    expect(shown.items.map(i => i.title)).toEqual(['Bold', 'Quiet'])
    expect(shown.sheet?.path).toMatch(/\/\.feedback\/shown\/options-\d+-\d+\.png$/)
    const raster = world.runs.find(r => r.argv[0] === 'rsvg-convert' && r.argv.at(-1) === shown.sheet!.path)
    expect(raster?.argv.slice(1, 3)).toEqual(['-w', '1468'])
  })

  test('options without a title are titled Options', async ($, on) => {
    await setup($, on, { [SHOT]: 'png', [SHOT_B]: 'png' })
    const reply = await call($, { options: [{ path: SHOT, title: 'Bold' }, { path: SHOT_B, title: 'Quiet' }] })
    expect(shownOf(reply.result)?.title).toBe('Options')
  })

  test('options still show when the sheet cannot be made', async ($, on) => {
    const { world } = await setup($, on, { [SHOT]: 'png', [SHOT_B]: 'png' })
    const answer = world.answer
    world.answer = argv => (argv[0] === 'rsvg-convert' ? { exitCode: 1, stdout: '', stderr: 'bad svg' } : answer(argv))
    const reply = await call($, { title: 'Hero', options: [{ path: SHOT, title: 'Bold' }, { path: SHOT_B, title: 'Quiet' }] })
    expect(reply.deny).toBeUndefined()
    const shown = shownOf(reply.result)!
    expect(shown.sheet).toBeUndefined()
    const ui = await $.ui.mount(resultRow(reply.result))
    expect(await ui.find({ key: 'all' })).toBeUndefined()
    expect(await ui.find({ key: 'pick' })).toMatchObject({ text: '✓ Pick A' })
    await ui.unmount()
  })

  test('a wireframe block renders through the vendored renderer, then rsvg-convert, and keeps its source', async ($, on) => {
    const { world } = await setup($, on, {})
    const reply = await call($, { wireframe: DSL, title: 'Settings panel' })
    expect(reply.deny).toBeUndefined()
    expect(reply.result?.split('\n')[0]).toMatch(/^Shown: Settings panel \(1440×900\)\. SVG at \.feedback\/shown\/settings-panel-\d+-\d+\.svg\.$/)
    const item = shownOf(reply.result)!.items[0]!
    expect(item.source.endsWith('.svg')).toBe(true)
    expect(item.path.endsWith('.png')).toBe(true)
    expect(world.files.get(item.source.replace(/\.svg$/, '.wireframe'))).toBe(DSL)
    const render = world.runs.find(r => r.argv[1]?.endsWith('/bin/wireframe-render.mjs'))
    expect(render?.argv[0]).toBe('node')
    expect(render?.argv.slice(3)).toEqual(['--out', item.source, '--strict'])
    expect(world.runs.some(r => r.argv[0] === 'rsvg-convert' && r.argv.at(-1) === item.path)).toBe(true)
  })

  test('a wireframe that fails to parse comes back as an error naming the line', async ($, on) => {
    await setup($, on, {})
    const reply = await call($, { wireframe: 'layout: single\nbody:\n\t- heading: x\n', title: 'Bad' })
    expect(reply.deny).toBe('show_image: The wireframe block did not render. wireframe did not parse: Line 3: tabs are not allowed; use 2 spaces per indent level.\nFix the block and show it again.')
  })

  test('without rsvg-convert an SVG goes through QuickLook and a crop', async ($, on) => {
    const { world } = await setup($, on, { [`${CWD}/wireframes/home.svg`]: '<svg viewBox="0 0 924 302"></svg>' })
    world.hasRsvg = false
    const reply = await call($, { path: 'wireframes/home.svg' })
    expect(reply.deny).toBeUndefined()
    const item = shownOf(reply.result)!.items[0]!
    expect(item.source).toBe(`${CWD}/wireframes/home.svg`)
    expect(world.runs.some(r => r.argv[0] === 'qlmanage')).toBe(true)
    const crop = world.runs.find(r => r.argv[0] === 'sips' && r.argv[1] === '-c')
    expect(crop?.argv.slice(1, 6)).toEqual(['-c', '523', '1600', '--cropOffset', '0'])
  })

  test('wireframe options draw as tabs like pictures do', async ($, on) => {
    await setup($, on, {})
    const reply = await call($, { title: 'Hero', options: [{ wireframe: DSL, title: 'Bold' }, { wireframe: DSL, title: 'Quiet' }] })
    expect(reply.deny).toBeUndefined()
    const ui = await $.ui.mount(resultRow(reply.result))
    expect(await ui.find({ key: 'tab-1' })).toMatchObject({ text: 'B Quiet' })
    await ui.unmount()
  })

  test('the system prompt tells Claude to show its work only when the tool is on offer', async ($, on) => {
    await setup($, on)
    expect((await $.prompt.compose(COMPOSE)).sections.map(s => s.id)).toEqual(['intro', 'agent-brief:outputs'])
    const withTool = await $.prompt.compose({ ...COMPOSE, tools: [SHOW_TOOL] })
    const section = withTool.sections.find(s => s.id === 'agent-brief:show')
    expect(section?.text).toContain('show it with show_image')
  })
})

describe('knowing whether pictures draw', () => {
  test('the band keeps drawing the clear pixel while no probe has answered', async ($, on) => {
    await setup($, on, { [SHOT]: 'png' }, { probe: 'none' })
    expect(JSON.stringify(await $.ui.render(BAND))).toContain('picture-probe')
    await $.ui.render(BAND)
    expect(JSON.stringify(await $.ui.render(BAND))).toContain('picture-probe')
  })

  test('the band leaves the pixel off once the probe has answered', async ($, on) => {
    await setup($, on)
    expect(JSON.stringify(await $.ui.render(BAND))).not.toContain('picture-probe')
  })

  test('before anything has drawn, a result tells Claude the user may not see it', async ($, on) => {
    await setup($, on, { [SHOT]: 'png' }, { probe: 'none' })
    const reply = await call($, { path: SHOT, title: 'Pricing page' })
    expect(reply.result?.split('\n')[0]).toBe(
      "Shown: Pricing page (1440×900). This terminal hasn't drawn a picture yet, so it may show a notice instead. Don't say the user can see it.",
    )
  })

  test('in a Herdr pane the first call already says it was not shown, and the row draws a Herdr notice', async ($, on) => {
    await setup($, on, { [SHOT]: 'png' }, { probe: 'alt', env: { HERDR_ENV: '1', TERM_PROGRAM: 'herdr' } })
    const reply = await call($, { path: SHOT, title: 'Pricing page' })
    expect(reply.result?.split('\n')[0]).toMatch(/^Not shown: Claude Code skips pictures in a Herdr pane until CLAUDE_CODE_FORCE_TERMINAL_IMAGES=1 is set/)
    expect(reply.result).toContain('agent-brief herdr-pictures on')
    const ui = await $.ui.mount(resultRow(reply.result))
    expect(textOf(await ui.drawn())).toContain('Turn on pictures for Herdr')
    expect(await ui.find({ type: 'Image' })).toBeUndefined()
    await ui.unmount()
  })
})

describe('the options sheet', () => {
  test('drops a letter or number put before an option title', () => {
    expect(optionTitle('A · Bottom composer')).toBe('Bottom composer')
    expect(optionTitle('2. Quiet')).toBe('Quiet')
    expect(optionTitle('Option C: Dock')).toBe('Dock')
    expect(optionTitle('A great idea')).toBe('A great idea')
    expect(optionTitle('B-side')).toBe('B-side')
  })

  test('lays two or three in a row and four two by two, with cards as tall as the tallest picture', () => {
    const cell = (height: number, title = 'X') => ({ href: 'data:image/png;base64,', width: 1600, height, title })
    expect(sheetOf([cell(800), cell(1600)])).toMatchObject({ width: 1468, height: 770 })
    expect(sheetOf([cell(800), cell(800), cell(800)]).width).toBe(2216)
    expect(sheetOf([cell(800), cell(800), cell(800), cell(800)])).toMatchObject({ width: 1468, height: 2 * (68 + 342 + 18) + 28 })
    const svg = sheetOf([cell(800, 'Fish & <chips>'), cell(800)]).svg
    expect(svg).toContain('Fish &amp; &lt;chips&gt;')
    expect(svg).toContain('>B</text>')
  })
})

describe('the picture in the transcript', () => {
  test('the call row is one line', async ($, on) => {
    await setup($, on)
    const ui = await $.ui.mount({
      plugin: 'agent-brief',
      surface: 'terminal',
      component: 'ToolUse',
      props: { tool_use_id: 't1', tool: SHOW_TOOL, input: { path: SHOT, title: 'Pricing' }, isRunning: false } as never,
    })
    expect(textOf(await ui.drawn())).toBe('▣ Image · Pricing')
    await ui.unmount()
  })

  test('the result row draws the picture from its kept copy, with Open, Finder and Copy buttons', async ($, on) => {
    await setup($, on)
    const reply = await call($, { path: SHOT, title: 'Pricing', url: 'http://localhost:3000/pricing', board: 'checkout' })
    const ui = await $.ui.mount(resultRow(reply.result))
    const image = await ui.find({ type: 'Image' })
    expect(image).toBeDefined()
    expect(await ui.find({ key: 'open' })).toMatchObject({ text: '↗ Open page' })
    expect(await ui.find({ key: 'board:checkout' })).toBeDefined()
    expect(await ui.find({ key: 'reveal' })).toBeDefined()
    expect(await ui.find({ key: 'copy' })).toBeDefined()
    expect(await ui.find({ key: 'pick' })).toBeUndefined()
    expect(textOf(await ui.drawn())).toContain('1440×900')
    await ui.unmount()
  })

  test('options draw as one sheet with a Pick for each, and a tab shows one alone', async ($, on) => {
    const { world, box } = await setup($, on, { [SHOT]: 'png', [SHOT_B]: 'png' })
    const reply = await call($, { title: 'Hero', options: [{ path: SHOT, title: 'Bold' }, { path: SHOT_B, title: 'Quiet' }] })
    const shown = shownOf(reply.result)!
    const ui = await $.ui.mount(resultRow(reply.result))
    const images = await ui.findAll({ type: 'Image' })
    expect(images).toHaveLength(1)
    expect(JSON.stringify(images[0])).toContain(shown.sheet!.path)
    expect(await ui.find({ key: 'all' })).toMatchObject({ text: '⧉ All' })
    expect(await ui.find({ key: 'tab-0' })).toMatchObject({ text: 'A Bold' })
    expect(await ui.find({ key: 'pick-0' })).toMatchObject({ text: '✓ Pick A' })
    expect(await ui.find({ key: 'pick-1' })).toMatchObject({ text: '✓ Pick B' })
    expect(await ui.find({ key: 'open' })).toBeUndefined()
    expect(textOf(await ui.drawn())).toContain('2 options')

    await ui.press({ key: 'tab-1' })
    expect(JSON.stringify(await ui.find({ type: 'Image' }))).toContain(shown.items[1]!.path)
    expect(textOf(await ui.drawn())).toContain('B of 2')
    expect(await ui.find({ key: 'pick' })).toMatchObject({ text: '✓ Pick B' })
    expect(await ui.find({ key: 'open' })).toBeDefined()
    await ui.press({ key: 'pick' })
    expect(world.toasts.at(-1)).toBe('Your pick is in the prompt box — press Enter')
    expect(box.text).toBe('Go with option B (Quiet) for Hero.')

    await ui.press({ key: 'all' })
    expect(await ui.find({ key: 'pick-1' })).toBeDefined()
    await ui.unmount()
  })

  test('a refused call draws a notice with a Copy prompt button', async ($, on) => {
    await setup($, on)
    const reply = await call($, { path: 'shots/gone.png' })
    const ui = await $.ui.mount(resultRow(reply.deny, true))
    expect(textOf(await ui.drawn())).toContain('File not found')
    expect(await ui.find({ key: 'copy-notice' })).toMatchObject({ text: 'Copy prompt' })
    await ui.unmount()
  })

  test('a kept copy that has gone draws the expired notice', async ($, on) => {
    const { world } = await setup($, on)
    const reply = await call($, { path: SHOT })
    world.files.delete(shownOf(reply.result)!.items[0]!.path)
    const ui = await $.ui.mount(resultRow(reply.result))
    expect(textOf(await ui.drawn())).toContain('This picture has expired')
    await ui.unmount()
  })

  test('another tool’s result is left to the engine', async ($, on) => {
    await setup($, on)
    const ui = await $.ui.mount({ ...resultRow('ok'), props: { tool_use_id: 't2', tool: 'Bash', output: { stdout: 'ok' }, isErrored: false } })
    expect(textOf(await ui.drawn())).toBe('engine band')
    await ui.unmount()
  })
})

describe('/show', () => {
  test('without a path prints the usage', async ($, on) => {
    await setup($, on)
    expect(await $.command.run(command('show'))).toEqual({ text: 'Usage: /show <path to a png, jpeg, webp, gif, tiff, svg or .wireframe>' })
  })

  test('opens a pane with the picture', async ($, on) => {
    const { opened } = await setup($, on)
    expect(await $.command.run(command('show', 'shots/page.png'))).toEqual({ text: 'Showing page.png (1440×900).' })
    expect(opened).toEqual(['agent-brief-show'])
    const ui = await $.ui.mount({ plugin: 'agent-brief', surface: 'terminal', component: 'Pane', requestId: 'agent-brief-show', viewport: VIEWPORT, props: {} as never })
    expect(await ui.find({ type: 'Image' })).toBeDefined()
    await ui.unmount()
  })
})

describe('a policy that refuses the plugin\'s tools', () => {
  /** Answers Bash beneath the plugin with what the command prints. Seat it before setup. */
  function bash(on: Parameters<TestBody>[1]) {
    const printed = { stdout: '' }
    on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: printed.stdout, stderr: '', interrupted: false } }) as never)
    return printed
  }

  const run = ($: Parameters<TestBody>[0], command: string) =>
    $.tool.call({ tool: 'Bash', tool_use_id: 'b1', command } as never) as Promise<{ result?: { stdout: string } }>

  test('leaves /show, /outputs and /apply-feedback registered', async ($, on) => {
    const { world } = await setup($, on, { [SHOT]: 'png' }, { isToolRefused: true })
    expect(world.tools).toEqual([])
    expect(world.commands).toEqual(expect.arrayContaining(['show', 'outputs', 'apply-feedback', 'sketch', 'mode']))
  })

  test('points the system prompt at agent-brief show and agent-brief output', async ($, on) => {
    await setup($, on, { [SHOT]: 'png' }, { isToolRefused: true })
    const sections = (await $.prompt.compose(COMPOSE)).sections
    expect(sections.find(s => s.id === 'agent-brief:show')?.text).toContain('`agent-brief show <file>` with Bash')
    expect(sections.find(s => s.id === 'agent-brief:outputs')?.text).toContain('`agent-brief output')
  })

  test('agent-brief show in Bash answers as show_image does, and its row draws the picture', async ($, on) => {
    const printed = bash(on)
    await setup($, on, { [SHOT]: 'png' }, { isToolRefused: true })
    printed.stdout = `${bashRequestLine({ kind: 'show', input: { path: SHOT, title: 'Pricing page' } })}\nAgent Brief draws this when its plugin runs.\n`
    const reply = await run($, `agent-brief show ${SHOT} --title "Pricing page"`)
    expect(reply.result?.stdout.split('\n')[0]).toBe('Shown: Pricing page (1440×900).')
    const ui = await $.ui.mount({ ...resultRow(reply.result), props: { tool_use_id: 't1', tool: 'Bash', output: reply.result, isErrored: false } })
    expect(await ui.find({ type: 'Image' })).toBeDefined()
    await ui.unmount()
  })

  test('a folded group of shell commands unfolds when one shows a picture', async ($, on) => {
    const printed = bash(on)
    on('ui.render', { component: 'ToolGroup' }, ($, e) => ({ type: 'Text', children: [`expanded ${String((e.props as { isExpanded: boolean }).isExpanded)}`] }) as never)
    await setup($, on, { [SHOT]: 'png' }, { isToolRefused: true })
    printed.stdout = `${bashRequestLine({ kind: 'show', input: { path: SHOT } })}\n`
    const reply = await run($, `agent-brief show ${SHOT}`)
    const group = (output: unknown) => ({
      plugin: 'agent-brief',
      surface: 'terminal' as const,
      component: 'ToolGroup' as const,
      requestId: 'g1',
      viewport: VIEWPORT,
      props: {
        isActive: false,
        isExpanded: false,
        calls: [
          { tool: 'Bash', input: { command: 'ls' }, isRunning: false, isErrored: false, isInterrupted: false, output: { stdout: 'a\n' } },
          { tool_use_id: 'b1', tool: 'Bash', input: { command: 'agent-brief show' }, isRunning: false, isErrored: false, isInterrupted: false, output },
        ],
      },
    })
    const shown = await $.ui.mount(group(reply.result))
    expect(textOf(await shown.drawn())).toBe('expanded true')
    await shown.unmount()
    const plain = await $.ui.mount(group({ stdout: 'b\n' }))
    expect(textOf(await plain.drawn())).toBe('expanded false')
    await plain.unmount()
  })

  test('a show command\'s row in an unfolded group draws the picture under the call', async ($, on) => {
    const printed = bash(on)
    await setup($, on, { [SHOT]: 'png' }, { isToolRefused: true })
    printed.stdout = `${bashRequestLine({ kind: 'show', input: { path: SHOT } })}\n`
    const reply = await run($, `agent-brief show ${SHOT}`)
    const callRow = (id: string) => ({
      plugin: 'agent-brief',
      surface: 'terminal' as const,
      component: 'ToolUse' as const,
      requestId: id,
      viewport: VIEWPORT,
      props: { tool_use_id: id, tool: 'Bash', input: { command: 'agent-brief show' }, isRunning: false, isErrored: false, isInterrupted: false, output: reply.result },
    })
    const standalone = await $.ui.mount(callRow('b1'))
    expect(await standalone.find({ type: 'Image' })).toBeUndefined()
    await standalone.unmount()
    const call = { tool_use_id: 'b1', tool: 'Bash', input: {}, isRunning: false, isErrored: false, isInterrupted: false, output: reply.result }
    const group = await $.ui.mount({ plugin: 'agent-brief', surface: 'terminal', component: 'ToolGroup', requestId: 'g1', viewport: VIEWPORT, props: { isActive: false, isExpanded: false, calls: [call] } })
    await group.drawn()
    await group.unmount()
    const grouped = await $.ui.mount(callRow('b1'))
    expect(textOf(await grouped.drawn())).toContain('engine band')
    expect(await grouped.find({ type: 'Image' })).toBeDefined()
    await grouped.unmount()
  })

  test('a missing file comes back as the line Claude acts on', async ($, on) => {
    const printed = bash(on)
    await setup($, on, { [SHOT]: 'png' }, { isToolRefused: true })
    printed.stdout = `${bashRequestLine({ kind: 'show', input: { path: `${CWD}/shots/gone.png` } })}\n`
    const reply = await run($, 'agent-brief show shots/gone.png')
    expect(reply.result?.stdout).toContain(`There's no file at ${CWD}/shots/gone.png`)
  })

  test('agent-brief output in Bash records a declared output', async ($, on) => {
    const printed = bash(on)
    on('session.id', () => ({ value: 's1' }))
    const { world } = await setup($, on, { [SHOT]: 'png' }, { isToolRefused: true })
    printed.stdout = `${bashRequestLine({ kind: 'output', input: { title: 'Pricing brief', path: `${CWD}/docs/pricing.md`, status: 'ready' } })}\n`
    const reply = await run($, 'agent-brief output "Pricing brief" --path docs/pricing.md --status ready')
    expect(reply.result?.stdout).not.toContain('agent-brief:request')
    const file = [...world.files].find(([path]) => path === `${CWD}/.feedback/outputs/s1.json`)
    expect(JSON.parse(file![1]).outputs[0]).toMatchObject({ ref: 'docs/pricing.md', title: 'Pricing brief', tier: 'declared', status: 'ready' })
  })

  test('other Bash output passes through untouched', async ($, on) => {
    const printed = bash(on)
    await setup($, on, { [SHOT]: 'png' }, { isToolRefused: true })
    printed.stdout = 'hello\n'
    expect((await run($, 'echo hello')).result?.stdout).toBe('hello\n')
  })
})
