import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import { bashRequestOf, outputsFile } from './companion-protocol'
import type { OutputsFile } from './companion-protocol'
import {
  DECLARE_TOOL,
  DECLARE_USAGE,
  declareResultText,
  emptyOutputsFile,
  isDocumentPath,
  kindOf,
  originOf,
  outputsListText,
  parseDeclare,
  parseOutputsFile,
  relRef,
  upsertDeclared,
  upsertWrite,
} from './outputs'

/** Set by register.tsx at session start, for engines without `session.root`. */
const homeRef = atom({ plugin: 'agent-brief', key: 'home' } as const, null)
/** What the Brief pane lists. Each write here keeps it current. */
const outputsRef = atom({ plugin: 'agent-brief', key: 'outputs' } as const, [])

/**
 * The session's project folder, where the app registers it and looks for its outputs.
 * A cd in the shell does not move it. Engines without `session.root` use the folder kept at start.
 * As homeCwd in register.tsx.
 */
async function homeCwd($: EngineInterface): Promise<string> {
  try {
    const root = await $.session.root()
    if (root) return root
  } catch {
    // An older engine has no session.root.
  }
  return (await read($, homeRef)) ?? (await $.session.cwd())
}

/** This session's outputs file, or an empty one when it is missing or unreadable. */
async function readOutputs($: EngineInterface): Promise<{ path: string; file: OutputsFile }> {
  const sessionId = await $.session.id()
  const path = outputsFile(await homeCwd($), sessionId)
  const text = await $.fs.read(path).catch(() => undefined)
  const file = (typeof text === 'string' ? parseOutputsFile(text) : undefined) ?? emptyOutputsFile(sessionId)
  return { path, file }
}

/** Chains outputs file changes so one write cannot clobber another, a subagent's included. */
let outputsQueue: Promise<unknown> = Promise.resolve()

function changeOutputs($: EngineInterface, change: (file: OutputsFile) => OutputsFile): Promise<OutputsFile> {
  const run = outputsQueue.then(async () => {
    const { path, file } = await readOutputs($)
    const changed = change(file)
    await $.fs.write(path, `${JSON.stringify(changed, null, 2)}\n`)
    await update($, outputsRef, () => changed.outputs).catch(err => log($, `outputs state failed: ${String(err)}`))
    return changed
  })
  outputsQueue = run.catch(() => undefined)
  return run
}

/** Answers `declare_output`. Never toasts. */
async function declareOutput($: EngineInterface, input: unknown): Promise<string> {
  const request = parseDeclare(input, await homeCwd($))
  if (request === undefined) return DECLARE_USAGE
  const at = await $.clock.now()
  const file = await changeOutputs($, f => upsertDeclared(f, { ...request, at }))
  const record = file.outputs.find(o => o.ref === request.ref)
  return record === undefined ? DECLARE_USAGE : declareResultText(record)
}

// The engine follows $ only into functions of the same file, so each hooks file keeps its own log.
function log($: EngineInterface, text: string): void {
  $.ui.log(`agent-brief: ${text}`, { to: 'debug' })
}

/** The session's outputs file: declared deliverables and the documents the session writes. */
export function registerOutputs(on: On): void {
  on('tool.call', { tool: DECLARE_TOOL }, async ($, e) => ({ result: await declareOutput($, e) })).catch(
    () => ({ result: 'Agent Brief could not record the output. The panel will not list it until a later declare succeeds.' }),
  )

  // `agent-brief output` in Bash declares the same way, where a policy refuses the declare_output tool.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const done = await next(e)
    const out = 'result' in done ? (done.result as { stdout?: unknown } | null | undefined) : undefined
    if (!out || typeof out.stdout !== 'string') return done
    const request = bashRequestOf(out.stdout)
    if (request?.kind !== 'output') return done
    const stdout = await declareOutput($, request.input)
    return { result: { ...out, stdout }, ...(done.context ? { context: done.context } : {}) }
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'outputs' }, async $ => ({ text: outputsListText((await readOutputs($)).file) }))

  // Records each document-type file the session writes, subagents included.
  // It runs inside the mode guard, so a denied edit never reaches it. A failure here never blocks the tool.
  on('tool.call', { tool: ['Edit', 'Write', 'NotebookEdit'] }, async ($, e, next) => {
    const path = e.tool === 'NotebookEdit' ? e.notebook_path : e.file_path
    const cwd = await homeCwd($).catch(() => undefined)
    const isDocument = cwd !== undefined && typeof path === 'string' && isDocumentPath(cwd, path)
    const before = isDocument ? await $.fs.stat(path).catch(() => undefined) : undefined
    const result = await next(e)
    const isRefused = typeof (result as { deny?: unknown }).deny === 'string'
    if (!isDocument || isRefused || (result as { isError?: unknown }).isError === true) return result
    try {
      const ref = relRef(cwd, path)
      const origin = originOf({
        existedBefore: before !== undefined,
        previousSize: before?.size ?? 0,
        newSize: e.tool === 'Write' ? e.content.length : 0,
        tool: e.tool,
      })
      const at = await $.clock.now()
      await changeOutputs($, file => upsertWrite(file, { ref, kind: kindOf(ref), origin, at }))
    } catch (err) {
      log($, `output record failed: ${String(err)}`)
    }
    return result
  }).catch(($, e, next) => next(e))
}
