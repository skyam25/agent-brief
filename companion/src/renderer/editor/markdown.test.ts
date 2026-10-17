import { MarkdownManager } from '@tiptap/markdown';
import { describe, expect, it } from 'vitest';
import { STARTER_TEMPLATES } from '../../main/templates';
import { findSlots } from '../../shared/slots';
import { escapeProse, lightenEscapes, schemaExtensions } from './markdown';

const manager = () => {
  const m = new MarkdownManager({ extensions: schemaExtensions() });
  lightenEscapes(m);
  return m;
};

const roundTrip = (markdown: string) => {
  const m = manager();
  return m.serialize(m.parse(markdown)).trim();
};

const paragraph = (text: string) => manager().serialize({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });

describe('Markdown round trip', () => {
  it('keeps every starter template as written', () => {
    for (const t of STARTER_TEMPLATES) expect(roundTrip(t.body), t.id).toBe(t.body.trim());
  });

  it('keeps every block the editor offers', () => {
    const doc = [
      '# Goal {{goal}}',
      'Plain line with **bold**, *italic*, ~~strike~~, `code` and [a link](https://example.com).',
      '## Steps',
      '- one\n- two\n  - nested',
      '1. first\n2. second',
      '- [ ] open\n- [x] done',
      '> a quote',
      '```ts\nconst a = 1;\n```',
      '---',
      '| Name | Value |\n| --- | --- |\n| a | 1 |',
      '![login form](att:abc123)',
    ].join('\n\n');
    const out = roundTrip(doc);
    for (const part of [
      '# Goal {{goal}}',
      '**bold**',
      '*italic*',
      '~~strike~~',
      '`code`',
      '[a link](https://example.com)',
      '## Steps',
      '- one\n- two\n  - nested',
      '1. first\n2. second',
      '- [ ] open\n- [x] done',
      '> a quote',
      '```ts\nconst a = 1;\n```',
      '---',
      '![login form](att:abc123)',
    ]) {
      expect(out).toContain(part);
    }
    expect(out).toMatch(/\| Name +\| Value +\|\n\| -+ \| -+ \|\n\| a +\| 1 +\|/);
    expect(roundTrip(out)).toBe(out);
  });

  it('opens a plain-text draft as paragraphs', () => {
    expect(roundTrip('line one\nline two\n\nafter a blank')).toBe('line one\nline two\n\nafter a blank');
  });

  it('keeps an attachment source verbatim', () => {
    expect(roundTrip('![](att:zz99yy88)')).toBe('![](att:zz99yy88)');
  });

  it('puts one blank line before a table, and none at the start', () => {
    const m = manager();
    expect(m.serialize(m.parse('| a |\n| --- |\n| 1 |'))).toMatch(/^\| a /);
    expect(m.serialize(m.parse('Intro\n\n| a |\n| --- |\n| 1 |'))).toMatch(/^Intro\n\n\| a /);
  });
});

describe('light escaping', () => {
  it('leaves ordinary prompt text alone', () => {
    for (const text of ['use snake_case_name here', 'a <div> tag & 2 < 3', '2 * 3 = 6', 'see ~/Library/Logs', 'C:\\dir\\file', 'issue #42 and [x] marks', 'Fix <Button> in App.tsx']) {
      expect(paragraph(text)).toBe(text);
    }
  });

  it('keeps slots whole', () => {
    const md = paragraph('fill {{a_b}} and {{*star*}} in');
    expect(findSlots(md).map((s) => s.name)).toEqual(['a_b', '*star*']);
  });

  it('escapes what would change meaning, and parses back to the same text', () => {
    const m = manager();
    for (const text of ['*not italic*', '_not italic_', '~~not struck~~', '`not code`', '[not](a link)', '# not a heading', '- not a list', '1. not a list', '> not a quote', '[ ] not a task', 'line\n---', '&amp; stays']) {
      const md = paragraph(text);
      expect(md).not.toBe(text);
      expect(m.parse(md).content).toEqual([{ type: 'paragraph', content: [{ type: 'text', text }] }]);
    }
  });

  it('escapes a numbered marker at its dot', () => {
    expect(escapeProse('2024. A year', true)).toBe('2024\\. A year');
    expect(escapeProse('2024. A year', false)).toBe('2024. A year');
  });
});
