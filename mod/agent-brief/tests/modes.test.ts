import { describe, expect, test } from 'claude-code/testing'

import {
  MODE_USAGE,
  bandLabel,
  deferralOf,
  denyText,
  isEditDenied,
  modeFilePaths,
  modePatch,
  modeReport,
  modeToast,
  parseModeArgs,
  parseModeFile,
  sectionText,
} from '../hooks/modes'

describe('parseModeArgs', () => {
  test('a bare /mode reports', () => {
    expect(parseModeArgs('')).toEqual({ kind: 'report' })
    expect(parseModeArgs('   ')).toEqual({ kind: 'report' })
  })

  test('sets default, product and orchestrate, any case', () => {
    expect(parseModeArgs('default')).toEqual({ kind: 'set', mode: 'default', fidelity: null })
    expect(parseModeArgs(' Product ')).toEqual({ kind: 'set', mode: 'product', fidelity: null })
    expect(parseModeArgs('orchestrate')).toEqual({ kind: 'set', mode: 'orchestrate', fidelity: null })
  })

  test('prototype takes a fidelity id or alias', () => {
    const rungs: [string, string][] = [
      ['wireframe', 'wireframe'],
      ['wire', 'wireframe'],
      ['styled', 'styled'],
      ['html', 'styled'],
      ['live-patch', 'live-patch'],
      ['live', 'live-patch'],
      ['freeze-patch', 'freeze-patch'],
      ['freeze', 'freeze-patch'],
      ['interactive', 'interactive'],
      ['inter', 'interactive'],
      ['existing', 'existing'],
      ['iterate', 'existing'],
    ]
    for (const [word, fidelity] of rungs) {
      expect(parseModeArgs(`prototype ${word}`), word).toEqual({ kind: 'set', mode: 'prototype', fidelity })
    }
  })

  test('prototype alone, unknown words and extra words ask for usage', () => {
    for (const args of ['prototype', 'prototype glossy', 'banana', 'product now', 'prototype html extra']) {
      expect(parseModeArgs(args), args).toEqual({ kind: 'usage' })
    }
    expect(MODE_USAGE).toContain('existing (iterate)')
    expect(MODE_USAGE).toContain('/mode prototype <fidelity>')
  })
})

describe('labels and messages', () => {
  test('the band names the mode and any fidelity', () => {
    expect(bandLabel('default', null)).toBe('◇ Mode')
    expect(bandLabel('product', null)).toBe('◇ Product')
    expect(bandLabel('prototype', 'styled')).toBe('◇ Prototype · styled HTML')
    expect(bandLabel('prototype', 'freeze-patch')).toBe('◇ Prototype · freeze + patch')
    expect(bandLabel('orchestrate', null)).toBe('◇ Orchestrate')
  })

  test('a change ends with the re-read note, and no change leaves it out', () => {
    expect(modeToast('product', null)).toBe(
      'Mode: Product. Edits to source files are off; documents stay on. The next turn re-reads the conversation.',
    )
    expect(modeToast('prototype', 'styled')).toMatch(/^Mode: Prototype at styled-HTML fidelity\. .* The next turn re-reads the conversation\.$/)
    expect(modeToast('default', null, false)).not.toContain('re-reads')
  })

  test('the report names the mode and how to change it', () => {
    expect(modeReport('default', null)).toContain('Mode: Default.')
    expect(modeReport('prototype', 'wireframe')).toBe('Mode: Prototype at wireframe fidelity. Switch with /mode default.')
  })

  test('deny text names the mode and the way out', () => {
    expect(denyText('product')).toBe('Product mode is on. Switch with /mode default to edit source files.')
    expect(denyText('orchestrate')).toBe('Orchestrate mode is on. Switch with /mode default to edit files.')
  })
})

describe('sectionText', () => {
  test('default adds nothing', () => {
    expect(sectionText('default', null, false)).toBeNull()
  })

  test('product and orchestrate step aside for an output style', () => {
    expect(sectionText('product', null, false)).toContain('Product mode is on')
    expect(sectionText('product', null, true)).toBeNull()
    expect(sectionText('orchestrate', null, false)).toContain('Orchestrate mode is on')
    expect(sectionText('orchestrate', null, true)).toBeNull()
  })

  test('prototype keeps its fidelity line under an output style', () => {
    const full = sectionText('prototype', 'wireframe', false)!
    expect(full).toContain('Prototype mode is on')
    expect(full).toContain('wireframes on the Agent Brief board')
    expect(full).toContain('A design spec that names a recommended mode wins')
    const styled = sectionText('prototype', 'wireframe', true)!
    expect(styled).not.toContain('Prototype mode is on')
    expect(styled).toContain('wireframes on the Agent Brief board')
    expect(sectionText('prototype', 'existing', false)).not.toContain('A design spec')
  })

  test('the text is the same every time and stays short', () => {
    expect(sectionText('product', null, false)).toBe(sectionText('product', null, false))
    for (const text of [sectionText('product', null, false), sectionText('orchestrate', null, false)]) {
      expect(text!.split(/\s+/).length).toBeLessThan(100)
    }
  })
})

describe('tool posture', () => {
  test('default leaves every tool where the engine put it', () => {
    for (const tool of ['Edit', 'Write', 'NotebookEdit', 'LSP', 'mcp__playwright__browser_click']) {
      expect(deferralOf('default', tool), tool).toBeUndefined()
    }
  })

  test('product defers browsers and notebooks, and keeps Bash', () => {
    expect(deferralOf('product', 'mcp__claude-in-chrome__navigate')).toBe(true)
    expect(deferralOf('product', 'mcp__playwright__browser_click')).toBe(true)
    expect(deferralOf('product', 'NotebookEdit')).toBe(true)
    expect(deferralOf('product', 'Workflow')).toBe(true)
    expect(deferralOf('product', 'Bash')).toBeUndefined()
    expect(deferralOf('product', 'Edit')).toBeUndefined()
  })

  test('prototype pins browsers and defers LSP', () => {
    expect(deferralOf('prototype', 'mcp__claude-in-chrome__computer')).toBe(false)
    expect(deferralOf('prototype', 'mcp__playwright__browser_snapshot')).toBe(false)
    expect(deferralOf('prototype', 'LSP')).toBe(true)
    expect(deferralOf('prototype', 'mcp__playwrightish__x')).toBeUndefined()
  })

  test('orchestrate defers the edit tools', () => {
    expect(deferralOf('orchestrate', 'Edit')).toBe(true)
    expect(deferralOf('orchestrate', 'Write')).toBe(true)
    expect(deferralOf('orchestrate', 'Read')).toBeUndefined()
  })

  test('product refuses source edits and lets documents through', () => {
    expect(isEditDenied('product', 'Edit', '/w/src/app.ts', false)).toBe(true)
    expect(isEditDenied('product', 'NotebookEdit', '/w/a.ipynb', false)).toBe(true)
    expect(isEditDenied('product', 'Write', undefined, false)).toBe(true)
    for (const path of ['/w/spec.md', '/w/a.MDX', '/w/n.txt', '/w/d.csv', '/w/p.json', '/w/c.yaml', '/w/c.yml', '/w/.feedback/x/shot.png', '.feedback/a.ts']) {
      expect(isEditDenied('product', 'Write', path, false), path).toBe(false)
    }
    expect(isEditDenied('product', 'Edit', '/w/src/app.ts', true), 'a subagent too').toBe(true)
  })

  test('orchestrate refuses the main loop only', () => {
    expect(isEditDenied('orchestrate', 'Edit', '/w/spec.md', false)).toBe(true)
    expect(isEditDenied('orchestrate', 'Edit', '/w/src/app.ts', true)).toBe(false)
  })

  test('default and prototype refuse nothing', () => {
    expect(isEditDenied('default', 'Edit', '/w/src/app.ts', false)).toBe(false)
    expect(isEditDenied('prototype', 'Write', '/w/src/app.ts', false)).toBe(false)
    expect(isEditDenied('product', 'Bash', '/w/src/app.ts', false)).toBe(false)
  })

  test('the mirror sends fidelity only with prototype', () => {
    expect(modePatch('product', null)).toEqual({ mode: 'product' })
    expect(modePatch('prototype', 'live-patch')).toEqual({ mode: 'prototype', fidelity: 'live-patch' })
    expect(modePatch('default', 'styled')).toEqual({ mode: 'default' })
  })
})

describe('the folder default', () => {
  test('looks from the cwd up to and including home', () => {
    expect(modeFilePaths('/home/me/code/app', '/home/me')).toEqual([
      '/home/me/code/app/.claude/agent-brief.local.md',
      '/home/me/code/.claude/agent-brief.local.md',
      '/home/me/.claude/agent-brief.local.md',
    ])
  })

  test('a cwd outside home looks up to the root', () => {
    expect(modeFilePaths('/work/', '/home/me')).toEqual(['/work/.claude/agent-brief.local.md', '/.claude/agent-brief.local.md'])
  })

  test('reads mode and fidelity from the frontmatter', () => {
    expect(parseModeFile('---\nmode: product\n---\nNotes.\n')).toEqual({ mode: 'product', fidelity: null })
    expect(parseModeFile('---\nmode: "prototype"\nfidelity: live\n---\n')).toEqual({ mode: 'prototype', fidelity: 'live-patch' })
    expect(parseModeFile('---\nmode: prototype\n---\n')).toBeUndefined()
    expect(parseModeFile('---\nmode: prototype\nfidelity: glossy\n---\n')).toBeUndefined()
  })

  test('ignores invalid values and text outside the frontmatter', () => {
    expect(parseModeFile('---\nmode: banana\n---\n')).toBeUndefined()
    expect(parseModeFile('mode: product\n')).toBeUndefined()
    expect(parseModeFile('---\nmode: product\n')).toBeUndefined()
    expect(parseModeFile('---\nfidelity: wire\n---\n')).toBeUndefined()
  })
})
