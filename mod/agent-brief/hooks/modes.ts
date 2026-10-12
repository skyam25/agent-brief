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

const BROWSER = ['mcp__claude-in-chrome__*', 'mcp__playwright__*']

/** Files product mode may still write: documents and data, never source. */
const DOCUMENT = /\.(md|mdx|txt|csv|json|ya?ml)$/i

type ModeSpec = {
  label: string
  /** Read by the system prompt section. Empty for default. */
  posture: string
  /** Tool names, or prefixes ending in `*`, moved behind ToolSearch. */
  deferred: readonly string[]
  /** Tool names, or prefixes ending in `*`, kept in the prompt's list. */
  pinned: readonly string[]
  /** `source` denies edits to anything but documents; `all` denies every edit from the main loop. */
  deny: 'none' | 'source' | 'all'
  toast: string
}

const MODES: Record<SessionMode, ModeSpec> = {
  default: {
    label: 'Default',
    posture: '',
    deferred: [],
    pinned: [],
    deny: 'none',
    toast: 'Claude Code runs as it does without the mod.',
  },
  product: {
    label: 'Product',
    posture:
      'Product mode is on for this session. The work is discovery, analysis, specs, acceptance criteria and go-to-market. ' +
      'Read, ask, analyze and write documents. Do not propose or make source-code changes, run builds or tests, or open a browser unless the user asks for that explicitly. ' +
      'Edits to source files are denied in this mode; markdown, text, CSV, JSON and YAML files and anything under .feedback/ are allowed. Switch with /mode default.',
    deferred: [...BROWSER, 'NotebookEdit', 'LSP', 'Workflow'],
    pinned: [],
    deny: 'source',
    toast: 'Edits to source files are off; documents stay on.',
  },
  prototype: {
    label: 'Prototype',
    posture:
      'Prototype mode is on for this session. Favor speed and visual fidelity over architecture. ' +
      'Prototypes are disposable; skip tests, refactors and git unless asked. Use the browser tools to capture and verify what you build.',
    deferred: ['NotebookEdit', 'LSP', 'Workflow'],
    pinned: BROWSER,
    deny: 'none',
    toast: 'Browser tools are loaded up front; NotebookEdit, LSP and Workflow wait behind ToolSearch.',
  },
  orchestrate: {
    label: 'Orchestrate',
    posture:
      'Orchestrate mode is on for this session. Break the work into tasks, hand each to a subagent with a narrow brief, and review what comes back. ' +
      'The main session does not edit files; its Edit, Write and NotebookEdit are denied, and subagents do the edits. Switch with /mode default.',
    deferred: [...EDIT_TOOLS, ...BROWSER],
    pinned: [],
    deny: 'all',
    toast: 'Claude hands the work to subagents; its own Edit, Write and NotebookEdit are off.',
  },
}

const SPEC_WINS =
  'A design spec that names a recommended mode wins over this default; a request that names a different rung wins for that request.'

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
    line: `Prototypes in this session default to a live-patch image over the current surface, first-pass and not durable. ${SPEC_WINS}`,
  },
  'freeze-patch': {
    label: 'Freeze + patch',
    phrase: 'at freeze + patch fidelity',
    aliases: ['freeze'],
    line: `Prototypes in this session default to a durable freeze + patch variant on the frozen baseline. ${SPEC_WINS}`,
  },
  interactive: {
    label: 'Interactive',
    phrase: 'at interactive fidelity',
    aliases: ['inter'],
    line:
      'Prototypes in this session default to an interactive poster + link with scenario states, built against the trusted baseline. ' +
      SPEC_WINS,
  },
  existing: {
    label: 'Match existing',
    phrase: 'on an existing prototype',
    aliases: ['iterate'],
    line:
      "This session iterates on an existing prototype. Read its fidelity and engine from the variant's tool.json or its files and keep them. " +
      "Follow the prototype skill's chain conventions; do not start a new variant unless asked.",
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
 * system prompt and tool list change and the prompt cache starts over.
 */
export function modeToast(mode: SessionMode, fidelity: PrototypeFidelity | null, isChanged = true): string {
  const text = `Mode: ${modeName(mode, fidelity)}. ${MODES[mode].toast}`
  return isChanged ? `${text} ${RE_READ}` : text
}

export function denyText(mode: SessionMode): string {
  const what = MODES[mode].deny === 'all' ? 'files' : 'source files'
  return `${modeLabel(mode)} mode is on. Switch with /mode default to edit ${what}.`
}

/**
 * The system prompt section for the mode, or null for none.
 * An output style replaces the posture; prototype keeps its fidelity line.
 */
export function sectionText(mode: SessionMode, fidelity: PrototypeFidelity | null, hasOutputStyle: boolean): string | null {
  if (mode === 'default') return null
  const posture = hasOutputStyle ? [] : [MODES[mode].posture]
  const lines = mode === 'prototype' ? [...posture, FIDELITIES[fidelity ?? DEFAULT_FIDELITY].line] : posture
  if (lines.length === 0) return null
  return `# Session mode (Agent Brief)\n\n${lines.join('\n\n')}`
}

const matches = (tool: string, pattern: string) =>
  pattern.endsWith('*') ? tool.startsWith(pattern.slice(0, -1)) : tool === pattern

/** True to defer the tool, false to pin it, undefined to leave the engine's placement. */
export function deferralOf(mode: SessionMode, tool: string): boolean | undefined {
  const spec = MODES[mode]
  if (spec.deferred.some(p => matches(tool, p))) return true
  if (spec.pinned.some(p => matches(tool, p))) return false
  return undefined
}

/** A path product mode may still write: a document, or anything under `.feedback/`. */
export function isDocumentPath(path: string): boolean {
  return DOCUMENT.test(path) || path.includes('/.feedback/') || path.startsWith('.feedback/')
}

/**
 * Whether the mode refuses this edit. Orchestrate refuses the main loop only,
 * so the subagents it hands work to can still edit.
 */
export function isEditDenied(mode: SessionMode, tool: string, path: string | undefined, isSubagent: boolean): boolean {
  if (!(EDIT_TOOLS as readonly string[]).includes(tool as EditTool)) return false
  const rule = MODES[mode].deny
  if (rule === 'all') return !isSubagent
  if (rule === 'source') return !isDocumentPath(path ?? '')
  return false
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
