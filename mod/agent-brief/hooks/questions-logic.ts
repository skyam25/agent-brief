import type { BriefQuestion, QuestionKind } from '../types'

export const ASK_TOOL = 'mcp__agent-brief__ask_questions'
export const GRILL_SECTION = 'agent-brief:grill'

export const MAX_QUESTIONS = 8
export const MIN_OPTIONS = 2
export const MAX_OPTIONS = 6

export const NOTHING_ANSWERED = 'Answer a question first, then Send answers.'

/** The Other choice that ends every options and select question: picked, it opens a field for the user's own words. */
export const OTHER_VALUE = '__other__'
export const OTHER_LABEL = 'Other…'
/** Marks a typed answer in the Send message, so Claude tells it from a listed option. */
export const OWN_WORDS = '(their own words)'
export const GRILL_USAGE = 'Usage: /grill [on|off]'

const KINDS: readonly QuestionKind[] = ['options', 'select', 'text']

export const ASK_USAGE =
  `ask_questions takes \`questions\`, 1 to ${MAX_QUESTIONS} of { id, text, kind, options }. ` +
  'id is unique and text is the question. kind is options (buttons), select (a dropdown) or text (a free answer). ' +
  `options and select need ${MIN_OPTIONS} to ${MAX_OPTIONS} distinct, non-empty options; text takes none.`

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** The tool as `$.tool.register` takes it. */
export const ASK_TOOL_SPEC = {
  name: 'ask_questions',
  description:
    'Asks the user a short round of questions in the Agent Brief pane beside the transcript, each with its own answer control. ' +
    'Use it when a request is underspecified and the answers change what you build. ' +
    'Use kind options for 2 to 4 short choices, select for up to 6, and text when the answer space is open. ' +
    'Calling it again replaces the questions not yet answered. ' +
    'The answers arrive as the user\'s next message, so end your turn after calling it.',
  inputSchema: {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_QUESTIONS,
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Unique within the round, such as "audience"' },
            text: { type: 'string', description: 'The question as the user reads it' },
            kind: { type: 'string', enum: [...KINDS] },
            options: {
              type: 'array',
              items: { type: 'string' },
              minItems: MIN_OPTIONS,
              maxItems: MAX_OPTIONS,
              description: 'The choices, for kind options or select',
            },
          },
          required: ['id', 'text', 'kind'],
        },
      },
    },
    required: ['questions'],
  },
  isDeferred: false as const,
}

export const GRILL_COMMAND_SPEC = {
  name: 'grill',
  description: 'Have Claude interview you with questions in the Brief pane before it starts: /grill, or /grill off',
  argumentHint: '[on|off]',
}

const isText = (value: unknown): value is string => typeof value === 'string' && value.trim() !== ''

function questionOf(raw: unknown): BriefQuestion | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const { id, text, kind, options } = raw as Record<string, unknown>
  if (!isText(id) || !isText(text) || !(KINDS as readonly unknown[]).includes(kind)) return undefined
  const question = { id: id.trim(), text: text.trim(), kind: kind as QuestionKind }
  if (question.kind === 'text') return question
  if (!Array.isArray(options) || !options.every(isText)) return undefined
  const choices = options.map(o => o.trim())
  const isSized = choices.length >= MIN_OPTIONS && choices.length <= MAX_OPTIONS
  if (!isSized || new Set(choices).size !== choices.length) return undefined
  return { ...question, options: choices }
}

/** The questions in an `ask_questions` input, or undefined when any of them breaks the rules in ASK_USAGE. */
export function parseQuestions(input: unknown): BriefQuestion[] | undefined {
  const list = (typeof input === 'object' && input !== null ? input : {}) as { questions?: unknown }
  if (!Array.isArray(list.questions)) return undefined
  if (list.questions.length < 1 || list.questions.length > MAX_QUESTIONS) return undefined
  const questions = list.questions.map(questionOf)
  if (questions.some(q => q === undefined)) return undefined
  const ids = questions.map(q => q!.id)
  return new Set(ids).size === ids.length ? (questions as BriefQuestion[]) : undefined
}

/** A new round: answered questions stay unless the round asks them again, and the new ones follow. */
export function askQuestions(held: readonly BriefQuestion[], asked: readonly BriefQuestion[]): BriefQuestion[] {
  const kept = held.filter(q => q.answer !== undefined && !asked.some(a => a.id === q.id))
  return [...kept, ...asked]
}

export function askedText(n: number): string {
  return `Asked ${plural(n, 'question', 'questions')} in the Brief pane. The answers arrive as the user's next message.`
}

/** The toast when questions arrive while the pane is closed. */
export function waitingText(n: number): string {
  return `${plural(n, 'question waits', 'questions wait')} in the Brief pane, press b`
}

/** Holds `text` as the answer to question `id`, closing its Other field. Blank text drops the answer. */
export function answerQuestion(questions: readonly BriefQuestion[], id: string, text: string): BriefQuestion[] {
  const answer = text.trim()
  return questions.map(q => {
    if (q.id !== id) return q
    const { answer: _, isOther: __, ...rest } = q
    return answer === '' ? rest : { ...rest, answer }
  })
}

/** Opens the Other field on an options or select question. A listed answer drops; the field takes the next one. */
export function openOther(questions: readonly BriefQuestion[], id: string): BriefQuestion[] {
  return questions.map(q => {
    if (q.id !== id || q.kind === 'text') return q
    const { answer: _, ...rest } = q
    return { ...rest, isOther: true }
  })
}

/** Holds `text`, the user's own words, as the answer in an open Other field. Blank text empties the field and keeps it open. */
export function typeOther(questions: readonly BriefQuestion[], id: string, text: string): BriefQuestion[] {
  const answer = text.trim()
  return questions.map(q => {
    if (q.id !== id || q.kind === 'text') return q
    const { answer: _, ...rest } = q
    return answer === '' ? { ...rest, isOther: true as const } : { ...rest, isOther: true as const, answer }
  })
}

export function answeredCount(questions: readonly BriefQuestion[]): number {
  return questions.filter(q => q.answer !== undefined).length
}

/** What Send answers submits, or undefined while nothing is answered. A typed answer to a listed question carries OWN_WORDS. */
export function answersMessage(questions: readonly BriefQuestion[]): string | undefined {
  if (answeredCount(questions) === 0) return undefined
  const lines = questions.map(q => `- ${q.text}: ${q.answer === undefined ? '(no answer)' : q.isOther ? `${q.answer} ${OWN_WORDS}` : q.answer}`)
  return ['Answers to your questions:', ...lines].join('\n')
}

/** `/grill` turns grilling on, `/grill off` turns it off. Undefined for anything else. */
export function grillTarget(args: string): boolean | undefined {
  const word = args.trim().toLowerCase()
  if (word === '' || word === 'on') return true
  if (word === 'off') return false
  return undefined
}

/** What `/grill` says: the state it leaves, and whether it changed. */
export function grillReply(isOn: boolean, wasOn: boolean): string {
  if (!isOn) return wasOn ? 'Grill off. Claude starts on requests without interviewing you first.' : 'Grill is already off.'
  const state = wasOn ? 'Grill is already on.' : 'Grill on.'
  return `${state} When a request is underspecified, Claude asks questions in the Brief pane before it starts. /grill off stops it.`
}

/**
 * The system prompt section while grilling is on.
 * `hasTool` is false when the engine refused ask_questions, so the questions go in the reply instead.
 */
export function grillInstructions(hasTool: boolean): string {
  const how = hasTool
    ? 'call the `ask_questions` tool with them, then end your turn. The answers arrive as the user\'s next message.'
    : 'ask them in your reply as a short numbered list, then end your turn. The ask_questions tool is off here.'
  const kinds = hasTool
    ? 'Use kind `options` where the answer space is small, `select` for up to six choices, and `text` where it is open.'
    : 'Offer two to four choices where the answer space is small. Leave the question open where it is not.'
  return `# Grill (Agent Brief)

The user turned on grill for this session. They want to be interviewed before you start work on a request that leaves real choices open.

When a request is underspecified, pick the three to five questions whose answers most change what you build, and ${how}
${kinds}
Ask about intent, audience, scope and constraints. Do not ask what you can find in the code or files yourself.
After each round, ask another only if the answers left something that blocks a good start.
Stop asking and start as soon as you can do the work well. A clear request needs no questions.`
}
