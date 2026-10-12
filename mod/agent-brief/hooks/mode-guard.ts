import { atom, read } from 'claude-code'
import type { On } from 'claude-code'

import { deferralOf, denyText, isEditDenied } from './modes'

// The engine reads state refs only from the file that uses them, so this one repeats register.tsx's.
const modeRef = atom({ plugin: 'agent-brief', key: 'mode' } as const, 'default')

/** What the session mode does to tools: which ones sit behind ToolSearch, and which edits it refuses. */
export function registerModeGuard(on: On): void {
  // Outside default mode, the mode moves some tools behind ToolSearch and keeps others in front.
  on('tool.describe', async ($, e, next) => {
    const isDeferred = deferralOf(await read($, modeRef), e.tool)
    if (isDeferred === undefined) return next(e)
    return { ...(await next(e)), isDeferred }
  })

  // Product mode refuses edits to source files; orchestrate refuses every edit from the main loop.
  // A guard that fails lets the edit through.
  on('tool.call', { tool: ['Edit', 'Write', 'NotebookEdit'] }, async ($, e, next) => {
    const mode = await read($, modeRef)
    const path = e.tool === 'NotebookEdit' ? e.notebook_path : e.file_path
    if (!isEditDenied(mode, e.tool, path, e.agentId !== undefined)) return next(e)
    return { deny: denyText(mode) }
  }).catch(($, e, next) => next(e))
}
