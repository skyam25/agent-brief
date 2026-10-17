import type { ModePatch, PrototypeFidelity, SessionMode } from './companion-protocol'

export const MODE_SECTION = 'agent-brief:mode'

/** The folder default, looked for in the cwd and each parent up to the home dir. */
export const MODE_FILE = '.claude/agent-brief.local.md'

export const MODE_IDS: readonly SessionMode[] = ['default', 'product', 'prototype', 'orchestrate']

export const FIDELITY_IDS: readonly PrototypeFidelity[] = [
  'wireframe',
  'styled',
  'live-patch',
  'freeze-patch',
  'interactive',
  'existing',
]

/** Fallback for prototype state with no fidelity. The parsers and pickers never produce that. */
export const DEFAULT_FIDELITY: PrototypeFidelity = 'styled'

const RE_READ = 'The next turn re-reads the conversation.'

const EDIT_TOOLS = ['Edit', 'Write', 'NotebookEdit'] as const
type EditTool = (typeof EDIT_TOOLS)[number]

/** Extension-based guardrail; the prompt also protects code and config in these formats. */
const DOCUMENT = /\.(md|mdx|txt|csv|json|ya?ml)$/i

type ModeSpec = {
  label: string
  /** Read by the system prompt section. Empty for default. */
  posture: string
  /** `ask-source` puts a source edit to the permission dialog; `deny-main` refuses every edit from the main loop. */
  guard: 'none' | 'ask-source' | 'deny-main'
  toast: string
}

const MODES: Record<SessionMode, ModeSpec> = {
  default: {
    label: 'Default',
    posture: '',
    guard: 'none',
    toast: 'Claude Code runs as it does without the mod.',
  },
  product: {
    label: 'Product',
    posture:
      'Product mode is on for this session. Focus on discovery, analysis, specs, acceptance criteria and go-to-market. ' +
      'Read and search code, browse for research, and delegate code investigations as needed. Recommend implementation approaches grounded in evidence. ' +
      'Write documents and analysis data freely. An edit to application source or configuration asks the user first, so make one only when they asked for that file, ' +
      'and prefer handing implementation to a subagent. Run builds or tests only when requested.',
    guard: 'ask-source',
    toast: 'Source edits ask first; documents write freely.',
  },
  prototype: {
    label: 'Prototype',
    posture:
      'Prototype mode is on for this session. Favor speed and visual fidelity over architecture. ' +
      'Keep changes scoped to the prototype. Skip tests, refactors and git operations unless asked. ' +
      'Verify web prototypes in the browser; verify wireframes on the Agent Brief board.',
    guard: 'none',
    toast: 'Every edit runs; the prompt leans toward speed and visual fidelity.',
  },
  orchestrate: {
    label: 'Orchestrate',
    posture:
      'Orchestrate mode is on for this session. Read and investigate to scope the work. ' +
      'Delegate tasks with clear deliverables to subagents, review their results, and synthesize the answer. ' +
      'Delegate all file edits, including tracking files; keep the main session read-only across all tools, including shell commands. ' +
      'Main-session Edit, Write and NotebookEdit are denied; subagents can edit. Switch with /mode default for direct edits.',
    guard: 'deny-main',
    toast: 'Claude hands the work to subagents; its own Edit, Write and NotebookEdit are off.',
  },
}

const SPEC_WINS =
  'Use the fidelity requested by the user, then the design spec, then this default.'

type FidelitySpec = {
  label: string
  /** How the toast and `/mode` name it: `at styled-HTML fidelity`. */
  phrase: string
  aliases: readonly string[]
  line: string
}

const FIDELITIES: Record<PrototypeFidelity, FidelitySpec> = {
  wireframe: {
    label: 'Wireframe',
    phrase: 'at wireframe fidelity',
    aliases: ['wire'],
    line:
      'Prototypes in this session are wireframes on the Agent Brief board: boxes, labels, flow arrows, no styling. ' +
      `Draw them with the agent-brief CLI. ${SPEC_WINS}`,
  },
  styled: {
    label: 'Styled HTML',
    phrase: 'at styled-HTML fidelity',
    aliases: ['html'],
    line:
      'Prototypes in this session default to styled-HTML fidelity: one standalone page, real layout and copy, placeholder data. ' +
      SPEC_WINS,
  },
  'live-patch': {
    label: 'Live patch',
    phrase: 'at live-patch fidelity',
    aliases: ['live'],
    line: `Default to live patch: overlay a proposed visual change on the current page or screenshot for quick review. ${SPEC_WINS}`,
  },
  'freeze-patch': {
    label: 'Freeze + patch',
    phrase: 'at freeze + patch fidelity',
    aliases: ['freeze'],
    line: `Default to freeze + patch: save the current surface as a baseline and create a separate visual variant, preserving the original. ${SPEC_WINS}`,
  },
  interactive: {
    label: 'Interactive',
    phrase: 'at interactive fidelity',
    aliases: ['inter'],
    line:
      'Default to an interactive prototype with working scenario states, a preview image and a link to open it. Use the supplied design or current product as the baseline. ' +
      SPEC_WINS,
  },
  existing: {
    label: 'Match existing',
    phrase: 'on an existing prototype',
    aliases: ['iterate'],
    line:
      'Iterate on the existing prototype, preserving its fidelity and implementation approach. ' +
      'Read tool.json when present; otherwise inspect its files. Follow available prototype instructions. Update the current variant unless asked to create another.',
  },
}

export const MODE_USAGE =
  'Use /mode, /mode default, /mode product, /mode orchestrate or /mode prototype <fidelity>. ' +
  'Fidelities: wireframe (wire), styled (html), live-patch (live), freeze-patch (freeze), interactive (inter), existing (iterate).'

export function modeLabel(mode: SessionMode): string {
  return MODES[mode].label
}

export function fidelityLabel(fidelity: PrototypeFidelity): string {
  return FIDELITIES[fidelity].label
}

/** The band button's label: `◇ Mode` in default, else the mode and any fidelity. */
export function bandLabel(mode: SessionMode, fidelity: PrototypeFidelity | null): string {
  if (mode === 'default') return '◇ Mode'
  if (mode !== 'prototype') return `◇ ${modeLabel(mode)}`
  const label = fidelityLabel(fidelity ?? DEFAULT_FIDELITY)
  return `◇ Prototype · ${label[0]!.toLowerCase()}${label.slice(1)}`
}

/** How a toast or `/mode` names the mode: `Product`, `Prototype at styled-HTML fidelity`. */
function modeName(mode: SessionMode, fidelity: PrototypeFidelity | null): string {
  if (mode !== 'prototype') return modeLabel(mode)
  return `Prototype ${FIDELITIES[fidelity ?? DEFAULT_FIDELITY].phrase}`
}

const isMode = (word: string): word is SessionMode => (MODE_IDS as readonly string[]).includes(word)

/** A fidelity id or alias, any case. Undefined for any other word. */
export function parseFidelity(word: string): PrototypeFidelity | undefined {
  const w = word.trim().toLowerCase()
  return FIDELITY_IDS.find(id => id === w || FIDELITIES[id].aliases.includes(w))
}

export type ModeChoice = { mode: SessionMode; fidelity: PrototypeFidelity | null }

export type ModeArgs = { kind: 'report' } | { kind: 'usage' } | ({ kind: 'set' } & ModeChoice)

/** Reads `/mode` arguments. Prototype needs a fidelity; anything unknown asks for usage. */
export function parseModeArgs(args: string): ModeArgs {
  const words = args.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return { kind: 'report' }
  const [word, rung, ...rest] = words
  if (rest.length > 0 || !isMode(word!)) return { kind: 'usage' }
  if (word !== 'prototype') return rung === undefined ? { kind: 'set', mode: word, fidelity: null } : { kind: 'usage' }
  const fidelity = rung === undefined ? undefined : parseFidelity(rung)
  return fidelity === undefined ? { kind: 'usage' } : { kind: 'set', mode: 'prototype', fidelity }
}

/** What a bare `/mode` says. */
export function modeReport(mode: SessionMode, fidelity: PrototypeFidelity | null): string {
  if (mode === 'default') return 'Mode: Default. Set one with /mode product, /mode prototype <fidelity> or /mode orchestrate.'
  return `Mode: ${modeName(mode, fidelity)}. Switch with /mode default.`
}

/**
 * What applying a mode says. A change ends with the re-read note, because the
 * system prompt changes and the prompt cache starts over.
 */
export function modeToast(mode: SessionMode, fidelity: PrototypeFidelity | null, isChanged = true): string {
  const text = `Mode: ${modeName(mode, fidelity)}. ${MODES[mode].toast}`
  return isChanged ? `${text} ${RE_READ}` : text
}

export function denyText(mode: SessionMode): string {
  return `${modeLabel(mode)} mode is on. Switch with /mode default to edit files.`
}

/** What the permission dialog shows when product mode puts a source edit to the user. */
export function askText(path: string | undefined): string {
  return `Product mode: this edits ${path ? path.split('/').at(-1) : 'a file'}, which is source, not a document.`
}

/**
 * The system prompt section for the mode, or null for none.
 * Mode rules apply independently of the user's output style.
 */
export function sectionText(mode: SessionMode, fidelity: PrototypeFidelity | null): string | null {
  if (mode === 'default') return null
  const posture = [MODES[mode].posture]
  const lines = mode === 'prototype' ? [...posture, FIDELITIES[fidelity ?? DEFAULT_FIDELITY].line] : posture
  return `# Session mode (Agent Brief)\n\n${lines.join('\n\n')}`
}

/** A path product mode may still write: a document, or anything under `.feedback/`. */
export function isDocumentPath(path: string): boolean {
  return DOCUMENT.test(path) || path.includes('/.feedback/') || path.startsWith('.feedback/')
}

export type EditVerdict = 'allow' | 'ask' | 'deny'

/**
 * What the mode does with this edit. Product puts a source edit to the user and lets
 * documents through. Orchestrate refuses the main loop only, so the subagents it hands
 * work to can still edit.
 */
export function editVerdict(mode: SessionMode, tool: string, path: string | undefined, isSubagent: boolean): EditVerdict {
  if (!(EDIT_TOOLS as readonly string[]).includes(tool as EditTool)) return 'allow'
  const guard = MODES[mode].guard
  if (guard === 'deny-main') return isSubagent ? 'allow' : 'deny'
  if (guard === 'ask-source') return isDocumentPath(path ?? '') ? 'allow' : 'ask'
  return 'allow'
}

/** The PATCH body that mirrors the mode to the app. Fidelity goes only with prototype. */
export function modePatch(mode: SessionMode, fidelity: PrototypeFidelity | null): ModePatch {
  return mode === 'prototype' && fidelity !== null ? { mode, fidelity } : { mode }
}

/** Where to look for the folder default: the cwd, then each parent, stopping at the home dir. */
export function modeFilePaths(cwd: string, home: string): string[] {
  const top = home.replace(/\/+$/, '')
  const paths: string[] = []
  let dir = cwd.replace(/\/+$/, '') || '/'
  for (;;) {
    paths.push(`${dir === '/' ? '' : dir}/${MODE_FILE}`)
    if (dir === top || dir === '/') return paths
    dir = dir.slice(0, dir.lastIndexOf('/')) || '/'
  }
}

/**
 * The mode a folder file's frontmatter names, from `mode:` and `fidelity:` lines.
 * Undefined when it names no valid mode, or prototype without a valid fidelity.
 */
export function parseModeFile(text: string): ModeChoice | undefined {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return undefined
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === '---')
  if (end < 0) return undefined
  const fields = new Map<string, string>()
  for (const line of lines.slice(1, end)) {
    const m = /^\s*([a-z]+)\s*:\s*(.*?)\s*$/i.exec(line)
    if (m) fields.set(m[1]!.toLowerCase(), m[2]!.replace(/^(['"])(.*)\1$/, '$2').trim().toLowerCase())
  }
  const mode = fields.get('mode') ?? ''
  if (!isMode(mode)) return undefined
  if (mode !== 'prototype') return { mode, fidelity: null }
  const fidelity = parseFidelity(fields.get('fidelity') ?? '')
  return fidelity === undefined ? undefined : { mode, fidelity }
}
