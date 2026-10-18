import type { BriefAnswer, BriefOutput, SessionMode } from '../types'
import { awaitsUser, parseItems } from './items-file'
import type { Decision } from './items-file'
import { modeLabel } from './modes'

export const BRIEF_PANE = 'brief'
export const BRIEF_COLUMNS = 60

/** The most rows the pane asks for while seated inline. The frame shrinks to fit a shorter tree. */
export const BRIEF_ROWS = 30

/** What Agree holds as the answer to a proposal. */
export const AGREE_TEXT = 'Agreed'

export const NOTHING_HELD = 'Answer an item first, then Send answers.'
export const NO_ITEMS_FILE = 'Claude has not written the items file yet.'
export const OUTPUT_NEEDS_UPDATE = 'Update Agent Brief to open outputs from here. This version opened the board instead.'

/** Clauses longer than this make a question free text rather than buttons. */
const SHORT = 40
const BRIEF_EXTENSIONS = ['md', 'markdown', 'mdx', 'html', 'htm']

const isUrl = (ref: string) => /^https?:\/\//i.test(ref)
const fileName = (ref: string) => ref.split('/').filter(Boolean).at(-1) ?? ref
const extensionOf = (ref: string) => {
  const name = fileName(ref)
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase()
}
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** True when the conversation already holds a prompt from the user, as a resumed session does. */
export function hasUserPrompt(messages: readonly { role: string; text: string }[]): boolean {
  return messages.some(m => m.role === 'user' && m.text.trim() !== '')
}

/** The last folder of the project path, for the pane's header. */
export function projectName(cwd: string): string {
  return cwd.replace(/\/+$/, '').split('/').at(-1) || cwd
}

// ── Outputs ───────────────────────────────────────────────────────────────

export type OutputRow = {
  ref: string
  label: string
  status: 'Drafting' | 'Ready' | 'Touched'
  isUrl: boolean
  /** True for a Markdown or HTML file the app opens as a note or in its review pane. */
  canBrief: boolean
}

const rowOf = (o: BriefOutput): OutputRow => ({
  ref: o.ref,
  label: o.tier === 'declared' ? (o.title ?? fileName(o.ref)) : o.ref,
  status: o.tier === 'detected' ? 'Touched' : o.status === 'ready' ? 'Ready' : 'Drafting',
  isUrl: isUrl(o.ref),
  canBrief: !isUrl(o.ref) && BRIEF_EXTENSIONS.includes(extensionOf(o.ref)),
})

/** Declared outputs, newest first, then touched documents in the order the session first wrote them. */
export function outputRows(outputs: readonly BriefOutput[]): { declared: OutputRow[]; touched: OutputRow[] } {
  const declared = outputs.filter(o => o.tier === 'declared').sort((a, b) => (b.declaredAt ?? 0) - (a.declaredAt ?? 0))
  return { declared: declared.map(rowOf), touched: outputs.filter(o => o.tier === 'detected').map(rowOf) }
}

/** What `open` takes for a row: the URL, or the file's absolute path. */
export function openTarget(cwd: string, ref: string): string {
  if (isUrl(ref) || ref.startsWith('/')) return ref
  return `${cwd.replace(/\/+$/, '')}/${ref}`
}

/** True when POST /open answered from an app that opened the output, not the board. */
export function isOutputOpened(body: unknown): boolean {
  const opened = (typeof body === 'object' && body !== null ? body : {}) as { opened?: unknown }
  return opened.opened === 'note' || opened.opened === 'review'
}

// ── Items ─────────────────────────────────────────────────────────────────

/**
 * How the pane takes an answer to Claude's latest line on an item:
 * one Button per option, a one-line Input, or Agree beside an Input for a proposal.
 */
export type AnswerControl = { kind: 'options'; options: string[] } | { kind: 'text' } | { kind: 'proposal' }

/** The text after the line's last colon or sentence break, where the options sit. */
function lastClause(text: string): string {
  const breaks = [...text.matchAll(/[:.!?]\s+/g)]
  const last = breaks.at(-1)
  return last === undefined ? text : text.slice(last.index! + last[0].length)
}

const isShort = (option: string) => option !== '' && option.length < SHORT

/**
 * The control for Claude's latest line. `A or B?` with two short clauses, or `A / B`
 * with two to four short options, draws a Button each; another question draws an
 * Input; a line that asks nothing is a proposal.
 */
export function answerControl(line: string): AnswerControl {
  const text = line.trim()
  const asks = text.endsWith('?')
  const clause = lastClause(text.replace(/\?+$/, '').trim())
  const slashed = clause.split(/\s+\/\s+/).map(o => o.trim())
  if (slashed.length >= 2 && slashed.length <= 4 && slashed.every(isShort)) return { kind: 'options', options: slashed }
  if (asks) {
    const either = clause.split(' or ').map(o => o.replace(/[,;]+$/, '').trim())
    if (either.length === 2 && either.every(isShort)) return { kind: 'options', options: either }
    return { kind: 'text' }
  }
  return { kind: 'proposal' }
}

export type ItemRow = {
  n: number
  title: string
  /** Claude's latest line, and the user's, on the item. */
  claude?: string
  you?: string
  /** Absent once the user has the last word, or on a done item. */
  control?: AnswerControl
  held?: string
}

/** The pane's item rows: open ones in file order, then done ones. */
export function itemRows(text: string | null, answers: readonly BriefAnswer[]): { open: ItemRow[]; done: ItemRow[] } {
  const rows = parseItems(text ?? '').items.map((item): ItemRow & { done: boolean } => {
    const claude = item.lines.filter(l => l.by === 'claude').at(-1)?.text
    const you = item.lines.filter(l => l.by === 'you').at(-1)?.text
    const held = answers.find(a => a.n === item.n)?.text
    return {
      n: item.n,
      title: item.title,
      done: item.done,
      ...(claude === undefined ? {} : { claude }),
      ...(you === undefined ? {} : { you }),
      ...(awaitsUser(item) && claude !== undefined ? { control: answerControl(claude) } : {}),
      ...(held === undefined ? {} : { held }),
    }
  })
  const strip = ({ done: _, ...row }: ItemRow & { done: boolean }): ItemRow => row
  return { open: rows.filter(r => !r.done).map(strip), done: rows.filter(r => r.done).map(strip) }
}

/** How many open items wait on the user: Claude spoke last on them. */
export function waitingCount(text: string | null): number {
  return parseItems(text ?? '').items.filter(awaitsUser).length
}

/** Holds `text` as item `n`'s answer, replacing one held before. Blank text holds nothing. */
export function holdAnswer(answers: readonly BriefAnswer[], n: number, text: string): BriefAnswer[] {
  const rest = answers.filter(a => a.n !== n)
  return text.trim() === '' ? rest : [...rest, { n, text: text.trim() }]
}

export function dropAnswer(answers: readonly BriefAnswer[], n: number): BriefAnswer[] {
  return answers.filter(a => a.n !== n)
}

/**
 * The held answers Send may still write to `text`, the file as read now.
 * An answer drops when its item is gone, or the user already has the last word
 * on it, as after an answer from the app's panel.
 */
export function heldDecisions(text: string, answers: readonly BriefAnswer[]): { decisions: Decision[]; dropped: number[] } {
  const items = parseItems(text).items
  const decisions: Decision[] = []
  const dropped: number[] = []
  for (const a of answers) {
    const item = items.find(i => i.n === a.n)
    const isStale = item === undefined || item.done || item.lines.at(-1)?.by === 'you' || a.text.trim() === ''
    if (isStale) dropped.push(a.n)
    else decisions.push({ n: a.n, text: a.text })
  }
  return { decisions, dropped }
}

export function droppedText(dropped: readonly number[]): string {
  const which = dropped.map(n => `#${n}`).join(', ')
  return `Left out ${which}: answered elsewhere or no longer in the file.`
}

// ── Band and inline seat ──────────────────────────────────────────────────

/** `waiting` counts items that wait on the user; `asked` counts Claude's questions in the pane. */
export type BriefCounts = { ready: number; drafting: number; waiting: number; asked: number }

export function briefCounts(outputs: readonly BriefOutput[], itemsText: string | null, asked = 0): BriefCounts {
  const declared = outputs.filter(o => o.tier === 'declared')
  return {
    ready: declared.filter(o => o.status === 'ready').length,
    drafting: declared.filter(o => o.status !== 'ready').length,
    waiting: waitingCount(itemsText),
    asked,
  }
}

/** The band's Brief button: Ready outputs, waiting items and questions when above zero, then the mode outside default. */
export function briefBandLabel(counts: BriefCounts, mode: SessionMode): string {
  const n = counts.ready + counts.waiting + counts.asked
  return `▣ Brief${n > 0 ? ` ${n}` : ''}${mode === 'default' ? '' : ` · ${modeLabel(mode)}`}`
}

/** The inline seat's one line: `▣ Brief · 2 ready · 1 drafting · 2 items waiting · 3 questions waiting · Prototype`. */
export function inlineSummary(counts: BriefCounts, mode: SessionMode): string {
  const parts = [
    ...(counts.ready > 0 ? [`${counts.ready} ready`] : []),
    ...(counts.drafting > 0 ? [`${counts.drafting} drafting`] : []),
    ...(counts.waiting > 0 ? [`${plural(counts.waiting, 'item', 'items')} waiting`] : []),
    ...(counts.asked > 0 ? [`${plural(counts.asked, 'question', 'questions')} waiting`] : []),
    ...(mode === 'default' ? [] : [modeLabel(mode)]),
  ]
  return ['▣ Brief', ...(parts.length === 0 ? ['nothing yet'] : parts)].join(' · ')
}
