import { atom, read } from 'claude-code'
import type { On } from 'claude-code'

import { askText, denyText, editVerdict } from './modes'

// The engine reads state refs only from the file that uses them, so this one repeats register.tsx's.
const modeRef = atom({ plugin: 'agent-brief', key: 'mode' } as const, 'default')

const EDIT_TOOLS = ['Edit', 'Write', 'NotebookEdit'] as const

function pathOf(tool: string, input: unknown): string | undefined {
  const args = (input ?? {}) as { file_path?: unknown; notebook_path?: unknown }
  const path = tool === 'NotebookEdit' ? args.notebook_path : args.file_path
  return typeof path === 'string' ? path : undefined
}

/** What the session mode does to edits: product asks before a source edit, orchestrate refuses the main loop's. */
export function registerModeGuard(on: On): void {
  // An ask goes to the permission dialog with the mode's reason. A guard that fails leaves the engine's verdict.
  on('tool.check', { tool: [...EDIT_TOOLS] }, async ($, e, next) => {
    const mode = await read($, modeRef)
    const verdict = editVerdict(mode, e.tool, pathOf(e.tool, e.input), e.agentId !== undefined)
    if (verdict === 'allow') return next(e)
    if (verdict === 'deny') return { decision: 'deny', reason: denyText(mode) }
    const below = await next(e)
    if (below.decision === 'deny') return below
    return { ...below, decision: 'ask', reason: askText(pathOf(e.tool, e.input)) }
  }).catch(($, e, next) => next(e))

  // Orchestrate's refusal also stands where a permission mode would skip the dialog.
  on('tool.call', { tool: [...EDIT_TOOLS] }, async ($, e, next) => {
    const mode = await read($, modeRef)
    const path = e.tool === 'NotebookEdit' ? e.notebook_path : e.file_path
    if (editVerdict(mode, e.tool, path, e.agentId !== undefined) !== 'deny') return next(e)
    return { deny: denyText(mode) }
  }).catch(($, e, next) => next(e))
}
