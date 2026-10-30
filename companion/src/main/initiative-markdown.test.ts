import { describe, expect, it } from 'vitest';
import { briefFileName, firstSentence, formatBrief, mergeOutputRows, newBrief, outputRow, outputRowTarget, parseBrief, parseFolderRow } from './initiative-markdown';

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

  it('keeps sub-bullets and prose when a list changes', () => {
    const b = parseBrief('# T\n\n## Decisions\n- D1\n  indented sub-bullet\na prose line\n\n## Open\n- q\n');
    const text = formatBrief(b, { ...b, decisions: ['D1', 'D2'] });
    expect(text).toBe('# T\n\n## Decisions\n- D1\n  indented sub-bullet\n- D2\na prose line\n\n## Open\n- q\n');
    expect(parseBrief(text).decisions).toEqual(['D1', 'D2']);
  });

  it('edits an item in place with the lines under it, and drops a removed item with its own', () => {
    const b = parseBrief('# T\n\n## Open\nIntro.\n* a\n  why a\n- b\n  why b\n- c\n');
    const text = formatBrief(b, { ...b, open: ['a, sharper', 'c'] });
    expect(text).toBe('# T\n\n## Open\nIntro.\n* a, sharper\n  why a\n- c\n');
  });

  it('keeps folder rows it cannot read when the map changes', () => {
    const b = parseBrief('# T\n\n## Folders\n- ~/PM/work → working\n- ~/PM/archive → archive\nSee the shared drive too.\n');
    expect(b.folders).toEqual([{ path: '~/PM/work', role: 'working' }]);
    const text = formatBrief(b, { ...b, folders: [...b.folders, { path: '~/PM/evidence', role: 'sources' }] });
    expect(text).toBe('# T\n\n## Folders\n- ~/PM/work → working\n- ~/PM/evidence → sources\n- ~/PM/archive → archive\nSee the shared drive too.\n');
    const removed = formatBrief(parseBrief(text), { ...parseBrief(text), folders: [] });
    expect(removed).toBe('# T\n\n## Folders\n- ~/PM/archive → archive\nSee the shared drive too.\n');
  });

  it('adds items after prose in a list section that had none', () => {
    const b = parseBrief('# T\n\n## Decisions\nNone yet, see the log.\n\n## Open\n');
    expect(formatBrief(b, { ...b, decisions: ['D1'] })).toBe('# T\n\n## Decisions\nNone yet, see the log.\n\n- D1\n\n## Open\n');
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

describe('Outputs rows', () => {
  const prd = { title: 'Checkout PRD', path: '/Users/pm/shop/docs/checkout prd.md' };
  const deck = { title: 'Review deck', url: 'https://claude.ai/artifact/abc' };

  it('writes a file row with its file name and a file link, and a URL row as a link', () => {
    expect(outputRow(prd)).toBe('Checkout PRD [checkout prd.md](<file:/Users/pm/shop/docs/checkout prd.md>)');
    expect(outputRow(deck)).toBe('[Review deck](https://claude.ai/artifact/abc)');
    expect(outputRow({ title: 'A [draft]', url: 'https://x.dev/a b' })).toBe('[A \\[draft\\]](<https://x.dev/a b>)');
  });

  it('reads the path or URL a row links to', () => {
    expect(outputRowTarget(outputRow(prd))).toBe(prd.path);
    expect(outputRowTarget(outputRow(deck))).toBe(deck.url);
    expect(outputRowTarget('Old plan [plan.md](file:///Users/pm/plan.md)')).toBe('/Users/pm/plan.md');
    expect(outputRowTarget('A note with no link')).toBeUndefined();
  });

  it('adds missing rows, retitles its own rows in place, and keeps the rest', () => {
    const rows = ['Kickoff notes, kept by hand', outputRow(prd)];
    expect(mergeOutputRows(rows, [prd, deck])).toEqual([...rows, outputRow(deck)]);
    const retitled = mergeOutputRows(rows, [{ ...prd, title: 'Checkout PRD v2' }]);
    expect(retitled).toEqual(['Kickoff notes, kept by hand', 'Checkout PRD v2 [checkout prd.md](<file:/Users/pm/shop/docs/checkout prd.md>)']);
  });

  it('leaves a row the user reworded around the link', () => {
    const reworded = `${outputRow(prd)} · signed off by Legal`;
    expect(mergeOutputRows([reworded], [{ ...prd, title: 'New title' }])).toEqual([reworded]);
  });

  it('parses the Outputs section, and a changed list rewrites only its rows', () => {
    const text = newBrief({ id: 'x1', title: 'Checkout', understanding: '', decisions: [], open: [], folders: [] });
    const b = parseBrief(text);
    expect(b.outputs).toEqual([]);
    const next = formatBrief(b, { ...b, outputs: [outputRow(prd)] });
    expect(next).toContain(`## Outputs\n- ${outputRow(prd)}\n\n## Sources\n`);
    expect(parseBrief(next).outputs).toEqual([outputRow(prd)]);
    expect(next.replace(`- ${outputRow(prd)}\n\n`, '\n')).toBe(text);
  });
});
