import { describe, expect, test } from 'claude-code/testing'

import type { BriefQuestion } from '../types'
import {
  answerQuestion,
  answersMessage,
  askQuestions,
  askedText,
  grillInstructions,
  grillReply,
  grillTarget,
  openOther,
  parseQuestions,
  typeOther,
  waitingText,
} from '../hooks/questions-logic'

const AUDIENCE = { id: 'audience', text: 'Who reads it?', kind: 'options', options: ['Engineers', 'Execs'] }
const LENGTH = { id: 'length', text: 'How long?', kind: 'select', options: ['One page', 'Two pages', 'Long'] }
const GOAL = { id: 'goal', text: 'What should it decide?', kind: 'text' }

describe('ask_questions input', () => {
  test('takes one to eight questions of each kind', () => {
    expect(parseQuestions({ questions: [AUDIENCE, LENGTH, GOAL] })).toEqual([AUDIENCE, LENGTH, GOAL])
    expect(parseQuestions({ questions: [] })).toBeUndefined()
    expect(parseQuestions({ questions: Array.from({ length: 9 }, (_, i) => ({ ...GOAL, id: `q${i}` })) })).toBeUndefined()
    expect(parseQuestions({})).toBeUndefined()
    expect(parseQuestions(null)).toBeUndefined()
  })

  test('trims text and drops options from a text question', () => {
    expect(parseQuestions({ questions: [{ id: ' goal ', text: ' Why? ', kind: 'text', options: ['a', 'b'] }] })).toEqual([
      { id: 'goal', text: 'Why?', kind: 'text' },
    ])
  })

  test('needs two to six distinct options for options and select', () => {
    expect(parseQuestions({ questions: [{ ...AUDIENCE, options: ['Only'] }] })).toBeUndefined()
    expect(parseQuestions({ questions: [{ ...LENGTH, options: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }] })).toBeUndefined()
    expect(parseQuestions({ questions: [{ ...AUDIENCE, options: ['Same', 'Same'] }] })).toBeUndefined()
    expect(parseQuestions({ questions: [{ ...AUDIENCE, options: ['Engineers', ' '] }] })).toBeUndefined()
    expect(parseQuestions({ questions: [{ id: 'x', text: 'Pick', kind: 'select' }] })).toBeUndefined()
  })

  test('refuses a missing id or text, an unknown kind and a repeated id', () => {
    expect(parseQuestions({ questions: [{ ...GOAL, id: '' }] })).toBeUndefined()
    expect(parseQuestions({ questions: [{ ...GOAL, text: '  ' }] })).toBeUndefined()
    expect(parseQuestions({ questions: [{ ...GOAL, kind: 'radio' }] })).toBeUndefined()
    expect(parseQuestions({ questions: [GOAL, { ...GOAL, text: 'Again?' }] })).toBeUndefined()
  })
})

describe('rounds and answers', () => {
  const held: BriefQuestion[] = [
    { id: 'audience', text: 'Who reads it?', kind: 'options', options: ['Engineers', 'Execs'], answer: 'Execs' },
    { id: 'goal', text: 'What should it decide?', kind: 'text' },
  ]

  test('a new round replaces unanswered questions and keeps answered ones', () => {
    const next = askQuestions(held, [{ id: 'tone', text: 'Tone?', kind: 'text' }])
    expect(next.map(q => q.id)).toEqual(['audience', 'tone'])
  })

  test('a question asked again replaces its answered copy', () => {
    const next = askQuestions(held, [{ id: 'audience', text: 'Who reads it first?', kind: 'text' }])
    expect(next).toEqual([{ id: 'audience', text: 'Who reads it first?', kind: 'text' }])
  })

  test('holds an answer, and blank text drops it', () => {
    const answered = answerQuestion(held, 'goal', '  Pick a vendor ')
    expect(answered[1]!.answer).toBe('Pick a vendor')
    expect(answerQuestion(answered, 'goal', '')[1]).toEqual({ id: 'goal', text: 'What should it decide?', kind: 'text' })
  })

  test('the message lists every question once one is answered', () => {
    expect(answersMessage(held)).toBe('Answers to your questions:\n- Who reads it?: Execs\n- What should it decide?: (no answer)')
    expect(answersMessage(answerQuestion(held, 'audience', ''))).toBeUndefined()
  })

  test('one question reads singular in the tool result and the toast', () => {
    expect(askedText(1)).toBe("Asked 1 question in the Brief pane. The answers arrive as the user's next message.")
    expect(waitingText(1)).toBe('1 question waits in the Brief pane, press b')
  })
})

describe('the Other choice', () => {
  test('opens a field, holds the typed words and marks them in the message', () => {
    const opened = openOther([AUDIENCE, LENGTH, GOAL] as BriefQuestion[], 'audience')
    expect(opened[0]).toEqual({ ...AUDIENCE, isOther: true })
    const typed = typeOther(opened, 'audience', ' Designers ')
    expect(typed[0]).toEqual({ ...AUDIENCE, isOther: true, answer: 'Designers' })
    expect(answersMessage(typed)).toBe(
      ['Answers to your questions:', '- Who reads it?: Designers (their own words)', '- How long?: (no answer)', '- What should it decide?: (no answer)'].join('\n'),
    )
    expect(typeOther(typed, 'audience', '')[0]).toEqual({ ...AUDIENCE, isOther: true })
  })

  test('Other drops a listed answer, and a listed option closes the field', () => {
    const answered = answerQuestion([AUDIENCE] as BriefQuestion[], 'audience', 'Execs')
    const opened = openOther(answered, 'audience')
    expect(opened[0]).toEqual({ ...AUDIENCE, isOther: true })
    const typed = typeOther(opened, 'audience', 'Designers')
    expect(answerQuestion(typed, 'audience', 'Execs')[0]).toEqual({ ...AUDIENCE, answer: 'Execs' })
    expect(answerQuestion(typed, 'audience', '')[0]).toEqual(AUDIENCE)
  })

  test('a text question has no Other', () => {
    expect(openOther([GOAL] as BriefQuestion[], 'goal')).toEqual([GOAL])
    expect(typeOther([GOAL] as BriefQuestion[], 'goal', 'x')).toEqual([GOAL])
  })
})

describe('/grill', () => {
  test('reads on and off', () => {
    expect(grillTarget('')).toBe(true)
    expect(grillTarget(' ON ')).toBe(true)
    expect(grillTarget('off')).toBe(false)
    expect(grillTarget('maybe')).toBeUndefined()
  })

  test('says the state it leaves', () => {
    expect(grillReply(true, false)).toMatch(/^Grill on\./)
    expect(grillReply(true, true)).toMatch(/^Grill is already on\./)
    expect(grillReply(false, true)).toMatch(/^Grill off\./)
    expect(grillReply(false, false)).toBe('Grill is already off.')
  })

  test('the section points at the tool, or at the reply when the tool is off', () => {
    expect(grillInstructions(true)).toContain('`ask_questions` tool')
    expect(grillInstructions(true)).toContain('three to five questions')
    expect(grillInstructions(false)).toContain('numbered list')
    expect(grillInstructions(false)).not.toContain('`ask_questions` tool')
  })
})
