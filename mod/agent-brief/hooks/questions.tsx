import { atom, read, update } from 'claude-code'
import type { ElementTable, EngineInterface, On } from 'claude-code'

import type { BriefQuestion } from '../types'
import { BRIEF_PANE } from './brief-logic'
import {
  ASK_TOOL,
  ASK_USAGE,
  GRILL_USAGE,
  answeredCount,
  askQuestions,
  askedText,
  grillReply,
  grillTarget,
  parseQuestions,
  waitingText,
} from './questions-logic'

const questionsRef = atom({ plugin: 'agent-brief', key: 'questions' } as const, [])
const grillingRef = atom({ plugin: 'agent-brief', key: 'grilling' } as const, false)

export type QuestionsActions = {
  answer: (id: string, text: string) => Promise<void>
  clear: (id: string) => Promise<void>
  send: () => Promise<void>
}

/**
 * The Brief pane's Questions section, or null while Claude has asked nothing.
 * It has its own Send answers; the Items section never shares it.
 * `hasFields` is false on a surface that draws no Input or Select, as mobile.
 */
export function questionsTree(table: ElementTable, questions: readonly BriefQuestion[], hasFields: boolean, act: QuestionsActions) {
  if (questions.length === 0) return null
  const { Box, Button, Text } = table
  const answered = answeredCount(questions)
  return (
    <Box flexDirection="column">
      <Text bold>{`Questions · from Claude · ${questions.length}`}</Text>
      {questions.map(q => questionTree(table, q, hasFields, act))}
      <Box marginTop={1}>
        <Button
          key="questions-send"
          label={answered > 0 ? `Send answers (${answered})` : 'Send answers'}
          {...(answered > 0 ? { variant: 'primary' as const } : {})}
          onPress={() => void act.send()}
        />
      </Box>
    </Box>
  )
}

function questionTree(table: ElementTable, q: BriefQuestion, hasFields: boolean, act: QuestionsActions) {
  const { Box, Button, Text } = table
  return (
    <Box key={`question-${q.id}`} flexDirection="column" marginTop={1}>
      <Text>{q.text}</Text>
      {controlTree(table, q, hasFields, act)}
      {q.answer !== undefined && (
        <Box columnGap={1}>
          <Text color="green">→ {q.answer}</Text>
          <Button key={`question-${q.id}-clear`} plain dimColor label="Clear" onPress={() => void act.clear(q.id)} />
        </Box>
      )}
    </Box>
  )
}

/** Buttons for options, a Select for select, an Input for text. A surface without fields draws Buttons where it can. */
function controlTree(table: ElementTable, q: BriefQuestion, hasFields: boolean, act: QuestionsActions) {
  const { Box, Button, Text } = table
  const { Input, Select } = (hasFields ? table : {}) as Partial<ElementTable<'terminal'>>
  const options = q.options ?? []
  if (q.kind === 'select' && Select) {
    return (
      <Select
        key={`question-${q.id}-select`}
        options={[...(q.answer === undefined ? [{ value: '', label: 'Pick one' }] : []), ...options.map(o => ({ value: o, label: o }))]}
        value={q.answer ?? ''}
        onSelect={value => {
          if (value !== '') void act.answer(q.id, value)
        }}
      />
    )
  }
  if (q.kind === 'text') {
    if (!Input) return <Text dimColor>Answer in the terminal.</Text>
    return (
      <Input
        key={`question-${q.id}-answer`}
        placeholder="Your answer"
        value={q.answer ?? ''}
        submitLabel="hold"
        onSubmit={value => void act.answer(q.id, value)}
      />
    )
  }
  return (
    <Box flexWrap="wrap" columnGap={1}>
      {options.map((option, i) => (
        <Button
          key={`question-${q.id}-option-${i}`}
          label={option}
          {...(q.answer === option ? { variant: 'primary' as const } : {})}
          onPress={() => void act.answer(q.id, option)}
        />
      ))}
    </Box>
  )
}

/** Answers `ask_questions`. The pane redraws when it is open; when it is closed a toast says where the questions wait. */
async function ask($: EngineInterface, input: unknown): Promise<string> {
  const asked = parseQuestions(input)
  if (asked === undefined) return ASK_USAGE
  const questions = await update($, questionsRef, held => askQuestions(held, asked))
  const panes = await $.ui.panes().catch(() => [])
  if (!panes.some(pane => pane.id === BRIEF_PANE)) $.ui.toast(waitingText(questions.length), { timeoutMs: 8000 })
  return askedText(asked.length)
}

// The engine follows $ only into functions of the same file, so each hooks file keeps its own log.
function log($: EngineInterface, text: string): void {
  $.ui.log(`agent-brief: ${text}`, { to: 'debug' })
}

/** The ask_questions tool and the /grill command. Their registration lives in register.tsx's session start. */
export function registerQuestions(on: On): void {
  on('tool.call', { tool: ASK_TOOL }, async ($, e) => ({ result: await ask($, e) })).catch(($, e) => {
    log($, `ask_questions failed for ${e.tool}`)
    return { result: 'Agent Brief could not show the questions. Ask them in your reply instead.' }
  })

  on('command.run', { command: 'grill' }, async ($, e) => {
    const isOn = grillTarget(e.args)
    if (isOn === undefined) return { text: GRILL_USAGE }
    const wasOn = await read($, grillingRef)
    await update($, grillingRef, () => isOn)
    return { text: grillReply(isOn, wasOn) }
  })
}
