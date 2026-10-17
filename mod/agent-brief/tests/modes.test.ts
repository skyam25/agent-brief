import { describe, expect, test } from 'claude-code/testing'

import {
  MODE_USAGE,
  bandLabel,
  denyText,
  editVerdict,
  askText,
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
      'Mode: Product. Source edits ask first; documents write freely. The next turn re-reads the conversation.',
    )
    expect(modeToast('prototype', 'styled')).toMatch(/^Mode: Prototype at styled-HTML fidelity\. .* The next turn re-reads the conversation\.$/)
    expect(modeToast('default', null, false)).not.toContain('re-reads')
  })

  test('the report names the mode and how to change it', () => {
    expect(modeReport('default', null)).toContain('Mode: Default.')
    expect(modeReport('prototype', 'wireframe')).toBe('Mode: Prototype at wireframe fidelity. Switch with /mode default.')
  })

  test('deny and ask texts name the mode and the file', () => {
    expect(denyText('orchestrate')).toBe('Orchestrate mode is on. Switch with /mode default to edit files.')
    expect(askText('/w/src/app.ts')).toBe('Product mode: this edits app.ts, which is source, not a document.')
    expect(askText(undefined)).toBe('Product mode: this edits a file, which is source, not a document.')
  })
})

describe('sectionText', () => {
  test('default adds nothing', () => {
    expect(sectionText('default', null)).toBeNull()
  })

  test('product and orchestrate include their mode rules', () => {
    expect(sectionText('product', null)).toContain('Product mode is on')
    expect(sectionText('orchestrate', null)).toContain('Orchestrate mode is on')
  })

  test('prototype includes posture, fidelity and precedence', () => {
    const full = sectionText('prototype', 'wireframe')!
    expect(full).toContain('Prototype mode is on')
    expect(full).toContain('wireframes on the Agent Brief board')
    expect(full).toContain('Use the fidelity requested by the user, then the design spec, then this default.')
    expect(sectionText('prototype', 'existing')).not.toContain('then this default')
  })

  test('the text is the same every time and stays short', () => {
    expect(sectionText('product', null)).toBe(sectionText('product', null))
    for (const text of [sectionText('product', null), sectionText('orchestrate', null)]) {
      expect(text!.split(/\s+/).length).toBeLessThan(100)
    }
  })
})

describe('edit verdict', () => {
  test('product asks on a source edit and lets documents through, in both loops', () => {
    expect(editVerdict('product', 'Edit', '/w/src/app.ts', false)).toBe('ask')
    expect(editVerdict('product', 'NotebookEdit', '/w/a.ipynb', false)).toBe('ask')
    expect(editVerdict('product', 'Write', undefined, false)).toBe('ask')
    expect(editVerdict('product', 'Edit', '/w/src/app.ts', true)).toBe('ask')
    for (const path of ['/w/spec.md', '/w/a.MDX', '/w/n.txt', '/w/d.csv', '/w/p.json', '/w/c.yaml', '/w/c.yml', '/w/.feedback/x/shot.png', '.feedback/a.ts']) {
      expect(editVerdict('product', 'Write', path, false), path).toBe('allow')
    }
  })

  test('orchestrate refuses the main loop only', () => {
    expect(editVerdict('orchestrate', 'Edit', '/w/spec.md', false)).toBe('deny')
    expect(editVerdict('orchestrate', 'Edit', '/w/src/app.ts', true)).toBe('allow')
  })

  test('default and prototype guard nothing, and other tools pass', () => {
    expect(editVerdict('default', 'Edit', '/w/src/app.ts', false)).toBe('allow')
    expect(editVerdict('prototype', 'Write', '/w/src/app.ts', false)).toBe('allow')
    expect(editVerdict('product', 'Bash', '/w/src/app.ts', false)).toBe('allow')
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
