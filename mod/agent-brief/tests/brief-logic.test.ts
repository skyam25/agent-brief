import { describe, expect, test } from 'claude-code/testing'

import {
  ago,
  answerControl,
  briefBandLabel,
  briefCounts,
  hasUserPrompt,
  heldDecisions,
  holdAnswer,
  inlineSummary,
  isOutputOpened,
  itemRows,
  openFeedback,
  openTarget,
  outputRows,
  projectName,
  waitingCount,
} from '../hooks/brief-logic'
import type { BriefOutput } from '../types'

const ITEMS = [
  '# Items · checkout',
  '',
  '- [ ] #1 Row height',
  '      Claude: 44px rows with 12px gaps, or 40px with 8px to fit six rows?',
  '- [ ] #2 Header copy',
  '      Claude: What should the header say?',
  '      You: Checkout',
  '- [ ] #3 Footer',
  '      Claude: I will move the links into the footer.',
  '- [x] #4 Pay button',
  '      Claude: done',
  '- [ ] #5 Empty state',
  '',
].join('\n')

const OUTPUTS: BriefOutput[] = [
  { ref: 'notes/touched.md', kind: 'markdown', tier: 'detected', origin: 'edited', lastWriteAt: 30, writes: 2 },
  { ref: 'docs/spec.md', title: 'Spec', kind: 'markdown', tier: 'declared', status: 'ready', declaredAt: 10 },
  { ref: 'deck.pdf', title: 'Deck', kind: 'pdf', tier: 'declared', status: 'drafting', declaredAt: 20 },
  { ref: 'https://claude.ai/artifact/x', url: 'https://claude.ai/artifact/x', title: 'Page', kind: 'artifact', tier: 'declared', status: 'ready', declaredAt: 5 },
  { ref: 'mock.html', kind: 'html', tier: 'detected', lastWriteAt: 40 },
]

describe('answerControl', () => {
  test('two short clauses joined by or make two buttons', () => {
    expect(answerControl('44px rows with 12px gaps, or 40px with 8px to fit six rows?')).toEqual({
      kind: 'options',
      options: ['44px rows with 12px gaps', '40px with 8px to fit six rows'],
    })
  })

  test('takes the options from the last sentence or the text after a colon', () => {
    expect(answerControl('Done for the list. The header or the footer?')).toEqual({ kind: 'options', options: ['The header', 'the footer'] })
    expect(answerControl('Row height: 44 / 40 / 36?')).toEqual({ kind: 'options', options: ['44', '40', '36'] })
  })

  test('A / B with two to four short options makes a button each, question mark or not', () => {
    expect(answerControl('Keep / Drop')).toEqual({ kind: 'options', options: ['Keep', 'Drop'] })
    expect(answerControl('a / b / c / d?')).toEqual({ kind: 'options', options: ['a', 'b', 'c', 'd'] })
  })

  test('five options, a long clause, or three or-clauses make an Input', () => {
    expect(answerControl('a / b / c / d / e?')).toEqual({ kind: 'text' })
    expect(answerControl('Should the list keep its current spacing all the way down, or switch?')).toEqual({ kind: 'text' })
    expect(answerControl('Red or green or blue?')).toEqual({ kind: 'text' })
    expect(answerControl('What should the header say?')).toEqual({ kind: 'text' })
  })

  test('a line that asks nothing is a proposal', () => {
    expect(answerControl('I will move the links into the footer.')).toEqual({ kind: 'proposal' })
    expect(answerControl('Use red or green')).toEqual({ kind: 'proposal' })
  })
})

describe('itemRows', () => {
  test('splits open and done items and gives a control only where Claude spoke last', () => {
    const { open, done } = itemRows(ITEMS, [{ n: 3, text: 'Agreed' }])
    expect(open.map(r => r.n)).toEqual([1, 2, 3, 5])
    expect(done.map(r => r.n)).toEqual([4])
    expect(open[0]!.control).toEqual({ kind: 'options', options: ['44px rows with 12px gaps', '40px with 8px to fit six rows'] })
    expect(open[1]).toEqual({ n: 2, title: 'Header copy', claude: 'What should the header say?', you: 'Checkout' })
    expect(open[2]).toMatchObject({ control: { kind: 'proposal' }, held: 'Agreed' })
    expect(open[3]).toEqual({ n: 5, title: 'Empty state' })
  })

  test('reads a missing file as no items', () => {
    expect(itemRows(null, [])).toEqual({ open: [], done: [] })
    expect(waitingCount(null)).toBe(0)
  })

  test('counts the items waiting on the user', () => {
    expect(waitingCount(ITEMS)).toBe(2)
  })
})

describe('held answers', () => {
  test('holding replaces the item\'s earlier answer, and blank text holds nothing', () => {
    const one = holdAnswer([], 1, ' 44px ')
    expect(one).toEqual([{ n: 1, text: '44px' }])
    expect(holdAnswer(one, 1, '40px')).toEqual([{ n: 1, text: '40px' }])
    expect(holdAnswer(one, 1, '  ')).toEqual([])
  })

  test('Send drops an answer whose item the user answered since, or that left the file', () => {
    const answered = ITEMS.replace('      Claude: I will move the links into the footer.', '      Claude: I will move the links into the footer.\n      You: fine')
    const held = [
      { n: 1, text: '44px' },
      { n: 3, text: 'Agreed' },
      { n: 9, text: 'gone' },
    ]
    expect(heldDecisions(answered, held)).toEqual({ decisions: [{ n: 1, text: '44px' }], dropped: [3, 9] })
  })

  test('Send drops an answer whose item Claude finished since', () => {
    const finished = ITEMS.replace('- [ ] #1', '- [x] #1')
    expect(heldDecisions(finished, [{ n: 1, text: '44px' }])).toEqual({ decisions: [], dropped: [1] })
  })
})

const FEEDBACK = [
  '# Feedback · checkout.html',
  '',
  '## Round 1 · customers · 2026-10-12',
  '',
  '- [ ] #1 Filters',
  '    Claude: 2026-10-12 · cataloged',
  '- [ ] #2 Accepted',
  '    Claude: 2026-10-12 · cataloged',
  '    You: 2026-10-12 · accept',
  '- [ ] #3 Reopened',
  '    Claude: 2026-10-12 · done',
  '    You: 2026-10-13 · reopen',
  '- [x] #4 Done',
  '    Claude: 2026-10-12 · done',
  '',
].join('\n')

describe('outputRows', () => {
  test('lists declared outputs newest first, then touched ones last written first', () => {
    const { declared, touched } = outputRows(OUTPUTS)
    expect(declared.map(r => [r.label, r.status])).toEqual([
      ['Deck', 'Drafting'],
      ['Spec', 'Ready'],
      ['Page', 'Ready'],
    ])
    expect(touched.map(r => [r.label, r.status, r.at])).toEqual([
      ['mock.html', undefined, 40],
      ['notes/touched.md', undefined, 30],
    ])
  })

  test('dates a declared output by its later declare or write', () => {
    const [row] = outputRows([{ ref: 'a.md', title: 'A', kind: 'markdown', tier: 'declared', status: 'ready', declaredAt: 10, lastWriteAt: 50 }]).declared
    expect(row.at).toBe(50)
  })

  test('says how long ago in coarse steps', () => {
    expect(ago(30_000)).toBe('just now')
    expect(ago(4 * 60_000)).toBe('4m ago')
    expect(ago(2 * 3_600_000 + 59 * 60_000)).toBe('2h ago')
    expect(ago(3 * 86_400_000)).toBe('3d ago')
    expect(ago(-5_000)).toBe('just now')
  })

  test('counts open and raised-again feedback items', () => {
    expect(openFeedback(FEEDBACK)).toBe(2)
    expect(openFeedback('# Feedback · page.html\n')).toBe(0)
    const { declared } = outputRows(OUTPUTS, { 'docs/spec.md': 2 })
    expect(declared.find(r => r.ref === 'docs/spec.md')!.feedback).toBe('Feedback · 2 open')
    expect(declared.find(r => r.label === 'Deck')!.feedback).toBeUndefined()
  })

  test('opens a URL as given and a file by its absolute path', () => {
    expect(openTarget('/work/', 'docs/spec.md')).toBe('/work/docs/spec.md')
    expect(openTarget('/work', '/tmp/a.md')).toBe('/tmp/a.md')
    expect(openTarget('/work', 'https://claude.ai/artifact/x')).toBe('https://claude.ai/artifact/x')
  })

  test('knows an app that opened the output from one that opened the board', () => {
    expect(isOutputOpened({ board: 'main', opened: 'note' })).toBe(true)
    expect(isOutputOpened({ board: 'main', opened: 'review' })).toBe(true)
    expect(isOutputOpened({ board: 'main', opened: 'board' })).toBe(false)
    expect(isOutputOpened({ board: 'main' })).toBe(false)
  })
})

describe('band and inline labels', () => {
  const counts = briefCounts(OUTPUTS, ITEMS)

  test('counts Ready and drafting outputs and waiting items', () => {
    expect(counts).toEqual({ ready: 2, drafting: 1, waiting: 2, asked: 0 })
  })

  test('the band button adds the count above zero and the mode outside default', () => {
    expect(briefBandLabel(counts, 'prototype')).toBe('▣ Brief 4 · Prototype')
    expect(briefBandLabel({ ready: 0, drafting: 3, waiting: 0, asked: 0 }, 'default')).toBe('▣ Brief')
    expect(briefBandLabel(briefCounts(OUTPUTS, ITEMS, 3), 'default')).toBe('▣ Brief 7')
  })

  test('the inline line names each count and the mode', () => {
    expect(inlineSummary({ ready: 2, drafting: 1, waiting: 2, asked: 0 }, 'prototype')).toBe('▣ Brief · 2 ready · 1 drafting · 2 items waiting · Prototype')
    expect(inlineSummary({ ready: 0, drafting: 0, waiting: 1, asked: 0 }, 'default')).toBe('▣ Brief · 1 item waiting')
    expect(inlineSummary({ ready: 0, drafting: 0, waiting: 0, asked: 0 }, 'default')).toBe('▣ Brief · nothing yet')
    expect(inlineSummary({ ready: 0, drafting: 0, waiting: 1, asked: 3 }, 'default')).toBe('▣ Brief · 1 item waiting · 3 questions waiting')
  })
})

describe('session facts', () => {
  test('a user message with text means the session has a prompt', () => {
    expect(hasUserPrompt([{ role: 'assistant', text: 'hi' }])).toBe(false)
    expect(hasUserPrompt([{ role: 'user', text: '' }])).toBe(false)
    expect(hasUserPrompt([{ role: 'user', text: 'plan it' }])).toBe(true)
  })

  test('the header names the project folder', () => {
    expect(projectName('/Users/me/Projects/agent-brief/')).toBe('agent-brief')
  })
})
