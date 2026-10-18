import { DOCUMENT_EXTENSIONS, OUTPUT_SKIP_DIRS } from './companion-protocol'
import type { OutputKind, OutputOrigin, OutputRecord, OutputStatus, OutputTier, OutputsFile } from './companion-protocol'

export const OUTPUTS_SECTION = 'agent-brief:outputs'
export const DECLARE_TOOL = 'mcp__agent-brief__declare_output'

export const DECLARE_USAGE =
  'declare_output needs a title and exactly one of path or url. ' +
  'path is a file relative to the project; url is an http or https link to an artifact or published page. ' +
  'status is drafting (the default) or ready.'

const KIND_BY_EXTENSION: Readonly<Record<string, OutputKind>> = {
  md: 'markdown',
  markdown: 'markdown',
  mdx: 'markdown',
  html: 'html',
  htm: 'html',
  pdf: 'pdf',
  docx: 'docx',
  pptx: 'pptx',
  xlsx: 'xlsx',
}

const KINDS: readonly OutputKind[] = ['markdown', 'html', 'pdf', 'docx', 'pptx', 'xlsx', 'artifact', 'other']
const TIERS: readonly OutputTier[] = ['declared', 'detected']
const STATUSES: readonly OutputStatus[] = ['drafting', 'ready']
const ORIGINS: readonly OutputOrigin[] = ['created', 'edited']

export function isUrl(ref: string): boolean {
  return /^https?:\/\//i.test(ref)
}

/** The lower-case extension of a path's last segment, or '' when it has none. */
function extensionOf(path: string): string {
  const name = path.split('/').at(-1) ?? ''
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase()
}

/** Collapses `.`, `..` and repeated slashes. */
function normalize(path: string): string {
  const isAbsolute = path.startsWith('/')
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `${isAbsolute ? '/' : ''}${parts.join('/')}`
}

/** The path relative to cwd when it lies inside it, else undefined. A relative path counts from cwd. */
function inside(cwd: string, path: string): string | undefined {
  const root = normalize(cwd).replace(/\/+$/, '')
  const full = normalize(path.startsWith('/') ? path : `${root}/${path}`)
  return full.startsWith(`${root}/`) ? full.slice(root.length + 1) : undefined
}

export function kindOf(ref: string): OutputKind {
  if (isUrl(ref)) return 'artifact'
  return KIND_BY_EXTENSION[extensionOf(ref)] ?? 'other'
}

/** True for a document-type file inside cwd and outside the skipped folders. */
export function isDocumentPath(cwd: string, path: string): boolean {
  if (isUrl(path)) return false
  const rel = inside(cwd, path)
  if (rel === undefined || !DOCUMENT_EXTENSIONS.includes(extensionOf(rel))) return false
  return !rel.split('/').slice(0, -1).some(dir => OUTPUT_SKIP_DIRS.includes(dir))
}

/** The record key: a path relative to cwd, an absolute path outside it, or the URL as given. */
export function relRef(cwd: string, path: string): string {
  if (isUrl(path)) return path
  return inside(cwd, path) ?? normalize(path)
}

export function originOf({
  existedBefore,
  previousSize,
  newSize,
  tool,
}: {
  existedBefore: boolean
  previousSize: number
  newSize: number
  tool: string
}): OutputOrigin {
  if (!existedBefore) return 'created'
  return tool === 'Write' && previousSize < newSize / 2 ? 'created' : 'edited'
}

export function emptyOutputsFile(sessionId: string): OutputsFile {
  return { version: 1, sessionId, outputs: [] }
}

/** Replaces the record with `ref`, or appends one, so records keep their first-appearance order. */
function put(file: OutputsFile, ref: string, change: (found: OutputRecord | undefined) => OutputRecord): OutputsFile {
  const at = file.outputs.findIndex(o => o.ref === ref)
  if (at < 0) return { ...file, outputs: [...file.outputs, change(undefined)] }
  return { ...file, outputs: file.outputs.map((o, i) => (i === at ? change(o) : o)) }
}

export function upsertWrite(
  file: OutputsFile,
  { ref, kind, origin, at }: { ref: string; kind: OutputKind; origin: OutputOrigin; at: number },
): OutputsFile {
  return put(file, ref, found =>
    found === undefined
      ? { ref, kind, tier: 'detected', origin, firstWriteAt: at, lastWriteAt: at, writes: 1 }
      : {
          ...found,
          origin: found.origin ?? origin,
          firstWriteAt: found.firstWriteAt ?? at,
          lastWriteAt: at,
          writes: (found.writes ?? 0) + 1,
        },
  )
}

export function upsertDeclared(
  file: OutputsFile,
  {
    ref,
    url,
    title,
    kind,
    status,
    at,
  }: { ref: string; url?: string; title: string; kind: OutputKind; status: OutputStatus; at: number },
): OutputsFile {
  return put(file, ref, found => ({
    ...found,
    ref,
    ...(url === undefined ? {} : { url }),
    title,
    kind,
    tier: 'declared',
    status,
    declaredAt: at,
  }))
}

const isOneOf = <T extends string>(values: readonly T[], value: unknown): value is T =>
  typeof value === 'string' && (values as readonly string[]).includes(value)

const isTime = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

/** A record with only its valid fields, or undefined without a ref, kind and tier. */
function recordOf(raw: unknown): OutputRecord | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const r = raw as Record<string, unknown>
  if (typeof r.ref !== 'string' || r.ref === '' || !isOneOf(KINDS, r.kind) || !isOneOf(TIERS, r.tier)) return undefined
  return {
    ref: r.ref,
    ...(typeof r.url === 'string' ? { url: r.url } : {}),
    ...(typeof r.title === 'string' ? { title: r.title } : {}),
    kind: r.kind,
    tier: r.tier,
    ...(isOneOf(STATUSES, r.status) ? { status: r.status } : {}),
    ...(isOneOf(ORIGINS, r.origin) ? { origin: r.origin } : {}),
    ...(isTime(r.declaredAt) ? { declaredAt: r.declaredAt } : {}),
    ...(isTime(r.firstWriteAt) ? { firstWriteAt: r.firstWriteAt } : {}),
    ...(isTime(r.lastWriteAt) ? { lastWriteAt: r.lastWriteAt } : {}),
    ...(isTime(r.writes) ? { writes: r.writes } : {}),
  }
}

/** Undefined unless the text is a version 1 file with an outputs array. Malformed records drop out. */
export function parseOutputsFile(text: string): OutputsFile | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof raw !== 'object' || raw === null) return undefined
  const r = raw as Record<string, unknown>
  if (r.version !== 1 || !Array.isArray(r.outputs)) return undefined
  return {
    version: 1,
    sessionId: typeof r.sessionId === 'string' ? r.sessionId : '',
    outputs: r.outputs.map(recordOf).filter((o): o is OutputRecord => o !== undefined),
  }
}

export type DeclareRequest = { ref: string; url?: string; title: string; kind: OutputKind; status: OutputStatus }

/** Reads `declare_output`'s input. Undefined when it lacks a title or has other than one of path and url. */
export function parseDeclare(input: unknown, cwd: string): DeclareRequest | undefined {
  const r = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
  const text = (value: unknown) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined)
  const title = text(r.title)
  const path = text(r.path)
  const url = text(r.url)
  const status = r.status === undefined ? 'drafting' : r.status
  if (title === undefined || (path === undefined) === (url === undefined) || !isOneOf(STATUSES, status)) return undefined
  if (url !== undefined) return isUrl(url) ? { ref: url, url, title, kind: 'artifact', status } : undefined
  const ref = relRef(cwd, path!)
  return { ref, title, kind: kindOf(ref), status }
}

const fileName = (ref: string) => ref.split('/').filter(Boolean).at(-1) ?? ref

/** What `/outputs` prints: declared outputs, newest first, then touched documents. */
export function outputsListText(file: OutputsFile): string {
  const declared = file.outputs
    .filter(o => o.tier === 'declared')
    .sort((a, b) => (b.declaredAt ?? 0) - (a.declaredAt ?? 0))
  const touched = file.outputs.filter(o => o.tier === 'detected')
  if (declared.length === 0 && touched.length === 0) return 'No outputs yet.'
  const blocks: string[] = []
  if (declared.length > 0) {
    const lines = declared.map(o => `• ${o.title ?? fileName(o.ref)} — ${o.ref} · ${o.status ?? 'drafting'}`)
    blocks.push(['Declared', ...lines].join('\n'))
  }
  if (touched.length > 0) {
    const writes = (n: number) => (n === 1 ? '1 write' : `${n} writes`)
    const lines = touched.map(o => `• ${o.ref} · ${o.origin ?? 'edited'} · ${writes(o.writes ?? 0)}`)
    blocks.push(['Touched', ...lines].join('\n'))
  }
  return blocks.join('\n\n')
}

export function declareResultText(record: OutputRecord): string {
  const title = record.title ?? fileName(record.ref)
  return `Declared "${title}" (${record.ref}, ${record.status ?? 'drafting'}). It shows in the Agent Brief panel.`
}

/**
 * The system prompt section: when to declare an output, and where text the user pastes elsewhere goes.
 * `isCli` swaps the declare_output tool for `agent-brief output` in Bash.
 */
export function outputsInstructions(isCli = false): string {
  const declare = isCli
    ? 'run `agent-brief output "<title>" --path <file> --status drafting` with Bash for it (the declare_output tool is off here)'
    : 'call the `declare_output` tool for it'
  const where = isCli
    ? 'Pass `--path` relative to the project for a file. Pass `--url` for an artifact or a published page.'
    : 'Pass `path` relative to the project for a file. Pass `url` for an artifact or a published page.'
  return `# Outputs (Agent Brief)

The Agent Brief panel lists this session's deliverables. The user opens them there to review.
When the user asks for a doc, brief, report, spec, page, deck or artifact, ${declare}.
${where}
Declare it with status \`drafting\` when you start the deliverable. Declare it again with \`ready\` when it is done.
Declare one primary output per request, usually. Pick the one the user will read first.
Never declare code, config, tests or files that serve the code.
Never declare the items file or anything under .feedback.
For interactive HTML prototypes, use the behavior-review skill to keep sourced behavior rules, open assumptions and simulated actions beside the prototype.
The panel already lists every document-type file you write as touched. Do not declare files to be thorough.

When the user asks for text they will paste somewhere else, such as a message, an email or a post, write it to an Agent Brief note instead of printing it.
Run \`agent-brief note "<title>"\` with Bash and the Markdown on stdin, in a quoted heredoc. Then say in one line that the note is in Agent Brief.
If the command fails, print the text instead.`
}
