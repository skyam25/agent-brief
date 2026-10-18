import { describe, expect, it } from 'vitest';
import { briefFileName, firstSentence, formatBrief, newBrief, parseBrief, parseFolderRow } from './initiative-markdown';

const PRICING = `---
agent_brief_id: "abc123"
---
# Pricing

## Understanding
Monthly-first wins on trial conversion. Legal still has to clear the trial terms.

## Decisions
- 2026-10-14 Monthly-first (B over A); supersedes 2026-09-30 annual-first. → [D-012](<file:~/PM/decisions/D-012.md>)

## Open
- Legal review of trial terms

## Working
- Pricing page · B (monthly-first) [v1](<file:~/PM/b.html>) current
- Pricing page · A (annual-first) [v3](<file:~/PM/a.html>) ruled out 2026-10-14

## Outputs
- [Pricing PRD](<https://example.com/prd>) authority: external · checked 2026-10-05

## Sources
- [Customer call 10/9](<file:~/PM/call.md>) 2026-10-09

## Grounding
- [Glossary](<file:~/PM/glossary.md>) read on demand

## Folders
- ~/PM/Product/05-projects/Pricing → working
- ~/PM/Product/08-evidence → sources
- ~/PM/Product/07-decisions → decisions · the shared log
- ~/PM/Product/01-strategy → grounding
`;

describe('parseBrief', () => {
  it('reads the front matter, title and the parsed sections', () => {
    const b = parseBrief(PRICING);
    expect(b.id).toBe('abc123');
    expect(b.title).toBe('Pricing');
    expect(b.understanding).toBe('Monthly-first wins on trial conversion. Legal still has to clear the trial terms.');
    expect(b.decisions).toEqual([
      '2026-10-14 Monthly-first (B over A); supersedes 2026-09-30 annual-first. → [D-012](<file:~/PM/decisions/D-012.md>)',
    ]);
    expect(b.open).toEqual(['Legal review of trial terms']);
    expect(b.folders).toEqual([
      { path: '~/PM/Product/05-projects/Pricing', role: 'working' },
      { path: '~/PM/Product/08-evidence', role: 'sources' },
      { path: '~/PM/Product/07-decisions', role: 'decisions', note: 'the shared log' },
      { path: '~/PM/Product/01-strategy', role: 'grounding' },
    ]);
  });

  it('keeps headings inside code fences in their section', () => {
    const b = parseBrief('# T\n\n## Understanding\nText\n\n```\n## Not a section\n```\n\n## Open\n- one\n');
    expect(b.sections.map((s) => s.name)).toEqual(['Understanding', 'Open']);
    expect(b.understanding).toContain('## Not a section');
  });

  it('matches section names regardless of case and skips rows with an unknown role', () => {
    const b = parseBrief('# T\n\n## folders\n- ~/a -> Working\n- ~/b → elsewhere\n');
    expect(b.folders).toEqual([{ path: '~/a', role: 'working' }]);
  });

  it('reads a file with no front matter or sections', () => {
    const b = parseBrief('# Hand made\n\nSome notes.\n');
    expect(b).toMatchObject({ id: undefined, title: 'Hand made', understanding: '', decisions: [], folders: [] });
  });
});

describe('formatBrief', () => {
  it('gives back the same text when nothing changed', () => {
    const b = parseBrief(PRICING);
    expect(formatBrief(b, b)).toBe(PRICING);
  });

  it('rewrites only the changed section and keeps the others byte for byte', () => {
    const b = parseBrief(PRICING);
    const text = formatBrief(b, { ...b, open: ['Legal review of trial terms', 'Annual discount size'] });
    expect(text).toBe(PRICING.replace('- Legal review of trial terms\n', '- Legal review of trial terms\n- Annual discount size\n'));
    expect(parseBrief(text).open).toHaveLength(2);
  });

  it('keeps unknown sections through a round trip', () => {
    const custom = PRICING.replace('## Folders', '## Risks\nSomething odd → here\n\n### Sub\nkept\n\n## Folders');
    const b = parseBrief(custom);
    const text = formatBrief(b, { ...b, understanding: 'New view.' });
    expect(text).toContain('## Risks\nSomething odd → here\n\n### Sub\nkept\n\n## Folders');
    expect(text).toContain('## Understanding\nNew view.\n\n## Decisions');
  });

  it('adds a missing section in its place', () => {
    const b = parseBrief('# T\n\n## Understanding\nHi.\n\n## Working\n- row\n');
    const text = formatBrief(b, { ...b, decisions: ['2026-10-17 Ship it'] });
    expect(text).toBe('# T\n\n## Understanding\nHi.\n\n## Decisions\n- 2026-10-17 Ship it\n\n## Working\n- row\n');
    const end = formatBrief(parseBrief(text), { ...parseBrief(text), folders: [{ path: '~/x', role: 'working' }] });
    expect(end.endsWith('## Working\n- row\n\n## Folders\n- ~/x → working\n')).toBe(true);
  });

  it('adds sections to a brief that had none', () => {
    const b = parseBrief('# Hand made\nNotes.\n');
    expect(formatBrief(b, { ...b, understanding: 'Now.' })).toBe('# Hand made\nNotes.\n\n## Understanding\nNow.\n');
  });
});

describe('newBrief', () => {
  it('writes every section and parses back to the same fields', () => {
    const text = newBrief({
      id: 'x1',
      title: 'Onboarding',
      understanding: 'Start here.',
      decisions: [],
      open: ['Who owns it'],
      folders: [{ path: '~/PM/Onboarding', role: 'working' }],
      working: ['Welcome email · draft'],
    });
    expect(text.startsWith('---\nagent_brief_id: "x1"\n---\n# Onboarding\n\n## Understanding\nStart here.\n\n## Decisions\n\n## Open\n- Who owns it\n')).toBe(true);
    const b = parseBrief(text);
    expect(b.sections.map((s) => s.name)).toEqual(['Understanding', 'Decisions', 'Open', 'Working', 'Outputs', 'Sources', 'Grounding', 'Folders']);
    expect(b).toMatchObject({ id: 'x1', title: 'Onboarding', understanding: 'Start here.', open: ['Who owns it'] });
    expect(b.folders).toEqual([{ path: '~/PM/Onboarding', role: 'working' }]);
    expect(formatBrief(b, b)).toBe(text);
  });
});

describe('helpers', () => {
  it('names the file after the title', () => {
    expect(briefFileName('Pricing')).toBe('Pricing brief.md');
    expect(briefFileName('Q4: plans/next')).toBe('Q4- plans-next brief.md');
  });

  it('takes the first sentence', () => {
    expect(firstSentence('Monthly-first wins. Legal next.')).toBe('Monthly-first wins.');
    expect(firstSentence('No stop here\nSecond line')).toBe('No stop here');
    expect(firstSentence('')).toBe('');
  });

  it('parses a folder row with a note', () => {
    expect(parseFolderRow('~/a b/c → outputs · shipped docs')).toEqual({ path: '~/a b/c', role: 'outputs', note: 'shipped docs' });
    expect(parseFolderRow('no arrow here')).toBeUndefined();
  });
});
