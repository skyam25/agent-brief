import type { On, RenderElement, RenderInput, RenderNode, SessionStartInput } from 'claude-code'

export const CWD = '/work'
export const HOME = '/home/me'
export const INBOX = `${HOME}/Downloads/feedback-inbox`

export const SESSION: SessionStartInput = { surface: 'terminal', isInteractive: true, cwd: CWD }

export const BAND: RenderInput<'AbovePrompt'> = {
  component: 'AbovePrompt',
  surface: 'terminal',
  requestId: 'band',
  viewport: { columns: 120, rows: 40, isFullscreen: true },
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 9 },
    view: {},
  },
}

/** What the engine passes `prompt.compose`. */
export const COMPOSE = {
  model: 'claude-opus-5-5',
  promptModel: 'claude-opus-5-5',
  surfaces: ['terminal' as const],
  tools: [],
  outputStyle: null,
  traits: [],
}

export const command = (name: string, args = '') => ({
  command: name,
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: true, columns: 120 },
})

export type Run = { argv: readonly string[]; timeoutMs?: number }

/** What the CLI prints for an ingested session named `name`. */
export const ingestLine = (name: string) =>
  JSON.stringify({
    ok: true,
    name,
    dir: `${CWD}/.feedback/${name}`,
    reportPath: `${CWD}/.feedback/${name}/report.md`,
    screenshots: [`${CWD}/.feedback/${name}/screenshots/001-0012.jpg`],
    counts: { annotations: 3, notes: 1, utterances: 4, markers: 0 },
  })

export type World = {
  files: Map<string, string>
  runs: Run[]
  toasts: string[]
  submitted: string[]
  tools: string[]
  commands: string[]
  /** True makes every `fs.write` fail. */
  isWriteRefused: boolean
  /** Answers each `process.run`; the default claims every mv and prints an ok ingest. */
  answer: (argv: readonly string[]) => { exitCode: number; stdout: string; stderr: string }
}

/** Seats an in-memory file system, host and engine beneath the plugin. */
export function worldOf(on: On, files: Readonly<Record<string, string>> = {}, cwd = CWD): World {
  const world: World = {
    files: new Map(Object.entries(files)),
    runs: [],
    toasts: [],
    submitted: [],
    tools: [],
    commands: [],
    isWriteRefused: false,
    answer: argv => {
      if (argv[0] === 'mv') {
        const [, from, to] = argv
        const text = world.files.get(from!)
        if (text === undefined) return { exitCode: 1, stdout: '', stderr: `mv: ${from}: No such file or directory` }
        world.files.delete(from!)
        world.files.set(to!, text)
        return { exitCode: 0, stdout: '', stderr: '' }
      }
      if (argv[1]?.endsWith('/bin/ingest.mjs')) {
        const name = argv[2]!.split('/').at(-1)!.replace(/\.zip$/, '')
        world.files.set(`${CWD}/.feedback/${name}/report.md`, `# Session Report: ${name}\n\n> 🎙️ [00:00] Rename the Pricing heading to Plans.\n`)
        return { exitCode: 0, stdout: `${ingestLine(name)}\n`, stderr: '' }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    },
  }

  const isDir = (path: string) => [...world.files.keys()].some(f => f.startsWith(`${path}/`))

  on('fs.list', ($, e) => {
    if (!isDir(e.path)) return { deny: `ENOENT: ${e.path}` }
    const names = new Map<string, 'file' | 'dir'>()
    for (const file of world.files.keys()) {
      if (!file.startsWith(`${e.path}/`)) continue
      const rest = file.slice(e.path.length + 1)
      names.set(rest.split('/')[0]!, rest.includes('/') ? 'dir' : 'file')
    }
    return {
      value: [...names].sort().map(([name, kind], i) => ({ name, kind, size: 1, mtimeMs: 1000 + i, isLink: false })),
    }
  })
  on('fs.stat', ($, e) => {
    const text = world.files.get(e.path)
    return text === undefined
      ? { deny: `ENOENT: ${e.path}` }
      : { value: { kind: 'file' as const, size: text.length, mtimeMs: 5000, isLink: false } }
  })
  on('fs.read', ($, e) => {
    const text = world.files.get(e.path)
    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: text }
  })
  on('fs.write', ($, e) => {
    if (world.isWriteRefused) return { deny: `EACCES: ${e.path}` }
    world.files.set(e.path, e.text)
    return { value: undefined }
  })
  on('process.run', ($, e) => {
    world.runs.push({ argv: e.argv, ...(e.init?.timeoutMs !== undefined ? { timeoutMs: e.init.timeoutMs } : {}) })
    return { value: { ...world.answer(e.argv), isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('env.get', ($, e) => ({ value: e.name === 'HOME' ? HOME : undefined }))
  on('session.cwd', () => ({ value: cwd }))
  on('ui.toast', ($, e) => {
    world.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('tool.register', ($, e) => {
    world.tools.push(e.name)
    return { value: { tool: `mcp__agent-brief__${e.name}` } }
  })
  on('command.register', ($, e) => {
    world.commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('prompt.submit', ($, e) => {
    world.submitted.push(e.text)
    return { text: e.text }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('ui.render', () => ({ type: 'Text', children: ['engine band'] }))
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude Code.', scope: 'shared' as const }] }))

  return world
}

/** A drawn tree as one string. */
export function textOf(node: RenderNode | RenderElement | null | undefined): string {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string') return node
  const children = (node as { children?: readonly RenderNode[] }).children ?? []
  return children.map(child => textOf(child)).join('')
}
