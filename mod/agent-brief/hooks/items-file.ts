/**
 * The items file a tracked session keeps at `<cwd>/.feedback/items/<sessionId>.md`.
 * A port of companion/src/shared/items.ts. Keep the two in step, so the app reads
 * the `You:` lines the Brief pane writes byte for byte as its own.
 *
 *   # Items · checkout review
 *
 *   - [ ] #2 Sidebar rows too tight
 *         Claude: 44px rows with 12px gaps, or 40px with 8px to fit six rows?
 *         You: 44 / 12
 *         Out: src/Checkout.tsx
 *   - [x] #1 Pay button above the fold
 *         Claude: done · moved into the first screen
 *
 * The first `# ` heading above the items is the title. An item is a `- [ ]` or
 * `- [x]` line with `#N` and a title. Indented lines under it belong to it:
 * `Claude:` and `You:` lines in order, `Out:` lines naming files, anything else a note.
 */

export type ItemLine = { by: 'claude' | 'you'; text: string }

export type Item = {
  n: number
  title: string
  done: boolean
  /** `Claude:` and `You:` lines, in file order. */
  lines: ItemLine[]
  /** Indented lines that are none of these. */
  notes: string[]
  /** Paths from `Out:` lines, relative to the project, in file order without repeats. */
  outputs: string[]
}

export type ItemsDoc = { title?: string; items: Item[] }

export type Decision = { n: number; text: string }

/** The items file's path relative to the session's project folder. */
export function itemsRelPath(sessionId: string): string {
  return `.feedback/items/${sessionId}.md`
}

/** As `itemsFile` in the app: where it keeps this session's items. */
export function itemsFile(cwd: string, sessionId: string): string {
  return `${cwd}/${itemsRelPath(sessionId)}`
}

const ITEM = /^- \[( |x|X)\] #(\d+)\s*(.*)$/
const SPEAKER = /^(Claude|You):\s?(.*)$/
const OUTPUT = /^Out:(.*)$/

export function parseItems(text: string): ItemsDoc {
  const doc: ItemsDoc = { items: [] }
  let current: Item | undefined
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '')
    const item = ITEM.exec(line)
    if (item) {
      current = { n: Number(item[2]), title: item[3]!.trim(), done: item[1] !== ' ', lines: [], notes: [], outputs: [] }
      doc.items.push(current)
      continue
    }
    if (line.trim() === '') continue
    if (/^\s+/.test(line) && current) {
      const body = line.trim()
      const spoken = SPEAKER.exec(body)
      const output = OUTPUT.exec(body)
      if (spoken) current.lines.push({ by: spoken[1] === 'You' ? 'you' : 'claude', text: spoken[2]!.trim() })
      else if (output) {
        const path = output[1]!.trim()
        if (path && !current.outputs.includes(path)) current.outputs.push(path)
      } else current.notes.push(body)
      continue
    }
    current = undefined
    if (doc.title === undefined && doc.items.length === 0 && line.startsWith('# ')) doc.title = line.slice(2).trim()
  }
  return doc
}

const INDENT = '      '

/** A decision as one line, so it stays inside its item's block. */
const oneLine = (text: string) => text.trim().replace(/\s*\n\s*/g, ' ')

/** True when Claude's last line on the item came after the user's, so it waits on them. */
export function awaitsUser(item: Item): boolean {
  if (item.done) return false
  const last = item.lines.at(-1)
  return last !== undefined && last.by === 'claude'
}

/**
 * Appends one `You:` line per decision under its item, keeping the rest of the
 * text byte for byte, line endings included. A trailing empty `You:` line on the
 * item is filled instead. Decisions for unknown items are left out, and a decision's
 * line breaks become spaces. The caller drops empty decisions.
 */
export function withDecisions(text: string, decisions: readonly Decision[]): string {
  const cr = text.includes('\r\n') ? '\r' : ''
  const lines = text.split('\n')
  const wanted = new Map(decisions.map(d => [d.n, oneLine(d.text)]))
  const out: string[] = []
  let itemN: number | undefined
  let indent = INDENT

  const flush = () => {
    if (itemN === undefined || !wanted.has(itemN)) return
    const decision = wanted.get(itemN)!

    // Blank lines at the end of the block go back after the decision.
    const blanks: string[] = []
    while (out.length > 0 && out[out.length - 1]!.trim() === '') blanks.unshift(out.pop()!)
    const last = out[out.length - 1]
    if (last !== undefined && /^\s+You:\s*$/.test(last)) {
      const eol = last.endsWith('\r') ? '\r' : ''
      out[out.length - 1] = `${last.trimEnd()} ${decision}${eol}`
    } else {
      out.push(`${indent}You: ${decision}${cr}`)
    }
    out.push(...blanks)
    wanted.delete(itemN)
  }

  for (const raw of lines) {
    const line = raw.replace(/\r$/, '')
    const item = ITEM.exec(line)
    if (item) {
      flush()
      itemN = Number(item[2])
      indent = INDENT
    } else if (itemN !== undefined && line.trim() !== '' && !/^\s/.test(line)) {
      flush()
      itemN = undefined
    } else if (itemN !== undefined && /^\s+\S/.test(line)) {
      indent = /^\s+/.exec(line)![0]
    }
    out.push(raw)
  }
  flush()
  return out.join('\n')
}

/** The prompt that reports non-empty decisions. `relPath` is the items file relative to the session's cwd. */
export function decisionsDraft(relPath: string, decisions: readonly Decision[], doc: ItemsDoc): string {
  const titleOf = (n: number) => doc.items.find(i => i.n === n)?.title
  const head = `Decisions on ${decisions.length === 1 ? 'an item' : `${decisions.length} items`} in ${relPath}:`
  const body = decisions.map(d => {
    const title = titleOf(d.n)
    return `#${d.n}${title ? ` ${title}` : ''}: ${oneLine(d.text)}`
  })
  return [head, ...body].join('\n')
}
