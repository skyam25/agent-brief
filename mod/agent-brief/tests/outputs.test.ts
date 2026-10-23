import { describe, expect, test } from 'claude-code/testing'

import {
  DECLARE_USAGE,
  declareResultText,
  emptyOutputsFile,
  isDocumentPath,
  kindOf,
  originOf,
  outputsInstructions,
  outputsListText,
  parseDeclare,
  relRef,
  upsertDeclared,
  upsertWrite,
} from '../hooks/outputs'

const CWD = '/work'

describe('kindOf', () => {
  test('maps document extensions, any case', () => {
    expect(kindOf('docs/a.md')).toBe('markdown')
    expect(kindOf('docs/a.MARKDOWN')).toBe('markdown')
    expect(kindOf('a.mdx')).toBe('markdown')
    expect(kindOf('site/index.html')).toBe('html')
    expect(kindOf('old.htm')).toBe('html')
    expect(kindOf('r.pdf')).toBe('pdf')
    expect(kindOf('r.docx')).toBe('docx')
    expect(kindOf('r.pptx')).toBe('pptx')
    expect(kindOf('r.xlsx')).toBe('xlsx')
  })

  test('a URL is an artifact; anything else is other', () => {
    expect(kindOf('https://claude.ai/artifact/abc')).toBe('artifact')
    expect(kindOf('http://localhost:3000/page.html')).toBe('artifact')
    expect(kindOf('src/app.ts')).toBe('other')
    expect(kindOf('Makefile')).toBe('other')
    expect(kindOf('.md')).toBe('other')
  })
})

describe('isDocumentPath', () => {
  test('a document inside cwd counts, absolute or relative', () => {
    expect(isDocumentPath(CWD, '/work/docs/plan.md')).toBe(true)
    expect(isDocumentPath(CWD, 'docs/plan.md')).toBe(true)
    expect(isDocumentPath(`${CWD}/`, '/work/README.md')).toBe(true)
  })

  test('code, files outside cwd and skipped folders never count', () => {
    expect(isDocumentPath(CWD, '/work/src/app.ts')).toBe(false)
    expect(isDocumentPath(CWD, '/elsewhere/plan.md')).toBe(false)
    expect(isDocumentPath(CWD, '/workshop/plan.md')).toBe(false)
    expect(isDocumentPath(CWD, '/work/../elsewhere/plan.md')).toBe(false)
    expect(isDocumentPath(CWD, '/work/.feedback/items/s1.md')).toBe(false)
    expect(isDocumentPath(CWD, '/work/.claude/agent-brief.local.md')).toBe(false)
    expect(isDocumentPath(CWD, '/work/packages/ui/node_modules/x/README.md')).toBe(false)
    expect(isDocumentPath(CWD, 'https://example.com/a.md')).toBe(false)
  })
})

describe('relRef', () => {
  test('makes paths under cwd relative and leaves URLs and outside paths whole', () => {
    expect(relRef(CWD, '/work/docs/plan.md')).toBe('docs/plan.md')
    expect(relRef(CWD, './docs//plan.md')).toBe('docs/plan.md')
    expect(relRef(CWD, 'https://claude.ai/artifact/abc')).toBe('https://claude.ai/artifact/abc')
    expect(relRef(CWD, '/elsewhere/plan.md')).toBe('/elsewhere/plan.md')
  })
})

describe('originOf', () => {
  test('a new file is created', () => {
    expect(originOf({ existedBefore: false, previousSize: 0, newSize: 0, tool: 'Edit' })).toBe('created')
  })

  test('a Write that replaces most of a file is created; otherwise edited', () => {
    expect(originOf({ existedBefore: true, previousSize: 10, newSize: 100, tool: 'Write' })).toBe('created')
    expect(originOf({ existedBefore: true, previousSize: 50, newSize: 100, tool: 'Write' })).toBe('edited')
    expect(originOf({ existedBefore: true, previousSize: 10, newSize: 100, tool: 'Edit' })).toBe('edited')
  })
})

describe('upsertWrite and upsertDeclared', () => {
  test('a first write adds a detected record; a second bumps it and keeps the first origin', () => {
    let file = upsertWrite(emptyOutputsFile('s1'), { ref: 'docs/plan.md', kind: 'markdown', origin: 'created', at: 1 })
    expect(file.outputs).toEqual([
      { ref: 'docs/plan.md', kind: 'markdown', tier: 'detected', origin: 'created', firstWriteAt: 1, lastWriteAt: 1, writes: 1 },
    ])
    file = upsertWrite(file, { ref: 'docs/plan.md', kind: 'markdown', origin: 'edited', at: 5 })
    expect(file.outputs[0]).toMatchObject({ origin: 'created', firstWriteAt: 1, lastWriteAt: 5, writes: 2 })
  })

  test('a declare on a detected record flips its tier and keeps its write stats', () => {
    let file = upsertWrite(emptyOutputsFile('s1'), { ref: 'docs/plan.md', kind: 'markdown', origin: 'created', at: 1 })
    file = upsertDeclared(file, { ref: 'docs/plan.md', title: 'Plan', kind: 'markdown', status: 'drafting', at: 3 })
    expect(file.outputs).toEqual([
      {
        ref: 'docs/plan.md',
        kind: 'markdown',
        tier: 'declared',
        title: 'Plan',
        status: 'drafting',
        origin: 'created',
        declaredAt: 3,
        firstWriteAt: 1,
        lastWriteAt: 1,
        writes: 1,
      },
    ])
  })

  test('a write on a declared record keeps its tier, title, status and declaredAt', () => {
    let file = upsertDeclared(emptyOutputsFile('s1'), { ref: 'docs/plan.md', title: 'Plan', kind: 'markdown', status: 'ready', at: 2 })
    file = upsertWrite(file, { ref: 'docs/plan.md', kind: 'markdown', origin: 'created', at: 4 })
    expect(file.outputs[0]).toMatchObject({ tier: 'declared', title: 'Plan', status: 'ready', declaredAt: 2, firstWriteAt: 4, writes: 1 })
  })

  test('a re-declare updates the status and stamps the new declaredAt, so a hidden row comes back', () => {
    let file = upsertDeclared(emptyOutputsFile('s1'), { ref: 'docs/plan.md', title: 'Plan', kind: 'markdown', status: 'drafting', at: 2 })
    file = upsertDeclared(file, { ref: 'docs/plan.md', title: 'Plan v2', kind: 'markdown', status: 'ready', at: 9 })
    expect(file.outputs).toHaveLength(1)
    expect(file.outputs[0]).toMatchObject({ title: 'Plan v2', status: 'ready', declaredAt: 9 })
  })

  test('records keep their first-appearance order', () => {
    let file = upsertWrite(emptyOutputsFile('s1'), { ref: 'a.md', kind: 'markdown', origin: 'created', at: 1 })
    file = upsertWrite(file, { ref: 'b.md', kind: 'markdown', origin: 'created', at: 2 })
    file = upsertDeclared(file, { ref: 'a.md', title: 'A', kind: 'markdown', status: 'ready', at: 3 })
    file = upsertWrite(file, { ref: 'a.md', kind: 'markdown', origin: 'edited', at: 4 })
    expect(file.outputs.map(o => o.ref)).toEqual(['a.md', 'b.md'])
  })
})

describe('parseDeclare', () => {
  test('refuses files outside the project instead of recording unopenable or aliased paths', () => {
    for (const path of ['/tmp/plan.md', '../plan.md', '../../tmp/plan.md', '/work', 'https://example.com/plan.md', 'bad\npath.md']) {
      expect(parseDeclare({ title: 'Plan', path }, CWD), path).toBeUndefined()
    }
    expect(parseDeclare({ title: 'Plan', path: 'docs/../plan.md' }, CWD)?.ref).toBe('plan.md')
  })
  test('takes a path relative to the project, with drafting as the default status', () => {
    expect(parseDeclare({ title: ' Plan ', path: '/work/docs/plan.md' }, CWD)).toEqual({
      ref: 'docs/plan.md',
      title: 'Plan',
      kind: 'markdown',
      status: 'drafting',
    })
  })

  test('takes a URL as an artifact', () => {
    expect(parseDeclare({ title: 'Page', url: 'https://claude.ai/artifact/abc', status: 'ready' }, CWD)).toEqual({
      ref: 'https://claude.ai/artifact/abc',
      url: 'https://claude.ai/artifact/abc',
      title: 'Page',
      kind: 'artifact',
      status: 'ready',
    })
  })

  test('refuses a missing title, both or neither of path and url, a bad URL or status', () => {
    expect(parseDeclare({ path: 'a.md' }, CWD)).toBeUndefined()
    expect(parseDeclare({ title: 'A' }, CWD)).toBeUndefined()
    expect(parseDeclare({ title: 'A', path: 'a.md', url: 'https://x.y' }, CWD)).toBeUndefined()
    expect(parseDeclare({ title: 'A', url: 'ftp://x.y' }, CWD)).toBeUndefined()
    expect(parseDeclare({ title: 'A', path: 'a.md', status: 'done' }, CWD)).toBeUndefined()
    expect(DECLARE_USAGE).toContain('exactly one of path or url')
  })
})

describe('declareResultText', () => {
  test('names the open line for Markdown and HTML only, with an absolute path', () => {
    const html = { ref: 'mock/a.html', title: 'Mock', kind: 'html', tier: 'declared', status: 'ready' } as const
    expect(declareResultText(html, '/work/')).toContain('agent-brief open --output "/work/mock/a.html"')
    const pdf = { ref: 'deck.pdf', title: 'Deck', kind: 'pdf', tier: 'declared', status: 'ready' } as const
    expect(declareResultText(pdf, '/work')).not.toContain('open --output')
  })
})

describe('text', () => {
  test('/outputs lists declared, newest first, then touched', () => {
    let file = upsertDeclared(emptyOutputsFile('s1'), { ref: 'docs/old.md', title: 'Old', kind: 'markdown', status: 'ready', at: 1 })
    file = upsertDeclared(file, { ref: 'docs/pricing.md', title: 'Pricing strategy', kind: 'markdown', status: 'drafting', at: 2 })
    file = upsertWrite(file, { ref: 'notes/a.md', kind: 'markdown', origin: 'created', at: 3 })
    file = upsertWrite(file, { ref: 'notes/b.html', kind: 'html', origin: 'edited', at: 3 })
    file = upsertWrite(file, { ref: 'notes/b.html', kind: 'html', origin: 'edited', at: 4 })
    expect(outputsListText(file)).toBe(
      [
        'Declared',
        '• Pricing strategy — docs/pricing.md · drafting',
        '• Old — docs/old.md · ready',
        '',
        'Touched',
        '• notes/a.md · created · 1 write',
        '• notes/b.html · edited · 2 writes',
      ].join('\n'),
    )
  })

  test('the instructions name the tool, the rules and the note command, in under 20 lines', () => {
    const text = outputsInstructions()
    expect(text.startsWith('# Outputs (Agent Brief)')).toBe(true)
    expect(text).toContain('declare_output')
    expect(text).toContain('drafting')
    expect(text).toContain('ready')
    expect(text).toContain('.feedback')
    expect(text).toContain('agent-brief note "<title>"')
    expect(text).toContain('If the command fails, print the text instead.')
    expect(outputsInstructions(true)).toContain('agent-brief note "<title>"')
    expect(text.split('\n').length).toBeLessThanOrEqual(18)
  })
})
