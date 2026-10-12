import { describe, expect, it } from 'vitest';
import { awaitsUser, decisionsDraft, parseItems, serializeItems, withDecisions, type Item } from './items';

const SAMPLE = [
  '# Items · checkout review',
  '',
  '- [ ] #2 Sidebar rows too tight',
  '      Claude: 44px rows with 12px gaps, or 40px with 8px to fit six rows?',
  '      You: 44 / 12',
  '      Claude: Done for the list. The header too?',
  '- [x] #1 Pay button above the fold',
  '      Claude: done · moved into the first screen · mocks/checkout-v2.png',
  '',
].join('\n');

const item = (over: Partial<Item>): Item => ({ n: 1, title: 't', done: false, lines: [], notes: [], outputs: [], ...over });

describe('parseItems', () => {
  it('reads the title, items, and Claude and You lines in order', () => {
    expect(parseItems(SAMPLE)).toEqual({
      title: 'Items · checkout review',
      items: [
        {
          n: 2,
          title: 'Sidebar rows too tight',
          done: false,
          lines: [
            { by: 'claude', text: '44px rows with 12px gaps, or 40px with 8px to fit six rows?' },
            { by: 'you', text: '44 / 12' },
            { by: 'claude', text: 'Done for the list. The header too?' },
          ],
          notes: [],
          outputs: [],
        },
        {
          n: 1,
          title: 'Pay button above the fold',
          done: true,
          lines: [{ by: 'claude', text: 'done · moved into the first screen · mocks/checkout-v2.png' }],
          notes: [],
          outputs: [],
        },
      ],
    });
  });

  it('reads CRLF files the same', () => {
    expect(parseItems(SAMPLE.replace(/\n/g, '\r\n'))).toEqual(parseItems(SAMPLE));
  });

  it('keeps other indented lines as notes, and items with no lines', () => {
    const doc = parseItems(['- [ ] #3 Empty state', '- [X] #4 Copy', '    see mocks/empty.png', '    Claude: ok'].join('\n'));
    expect(doc.title).toBeUndefined();
    expect(doc.items).toEqual([
      { n: 3, title: 'Empty state', done: false, lines: [], notes: [], outputs: [] },
      { n: 4, title: 'Copy', done: true, lines: [{ by: 'claude', text: 'ok' }], notes: ['see mocks/empty.png'], outputs: [] },
    ]);
  });

  it('keeps lines across blank lines inside an item', () => {
    const doc = parseItems(['- [ ] #1 A', '      Claude: q', '', '      You: a'].join('\n'));
    expect(doc.items[0]!.lines.map((l) => l.by)).toEqual(['claude', 'you']);
  });

  it('ignores text between items, and indented lines after it', () => {
    const doc = parseItems(
      ['Some intro.', '  indented intro', '- [ ] #1 A', '      Claude: q', 'Loose paragraph.', '      Claude: orphan', '- [ ] #2 B', '# Late heading'].join('\n'),
    );
    expect(doc.title).toBeUndefined();
    expect(doc.items.map((i) => [i.n, i.lines.length, i.notes.length])).toEqual([
      [1, 1, 0],
      [2, 0, 0],
    ]);
  });

  it('takes only the first heading as the title', () => {
    expect(parseItems('# One\n# Two\n').title).toBe('One');
  });

  it('reads Out lines as outputs, trimmed and without repeats, and skips an empty one', () => {
    const doc = parseItems(
      [
        '- [ ] #1 A',
        '      Claude: writing src/Checkout.tsx',
        '      Out:  src/Checkout.tsx ',
        '      Out:',
        '      Out: mocks/a b.png',
        '      Out: src/Checkout.tsx',
        '      You: ok',
      ].join('\n'),
    );
    expect(doc.items[0]).toMatchObject({
      lines: [
        { by: 'claude', text: 'writing src/Checkout.tsx' },
        { by: 'you', text: 'ok' },
      ],
      notes: [],
      outputs: ['src/Checkout.tsx', 'mocks/a b.png'],
    });
  });

  it('reads an empty file', () => {
    expect(parseItems('')).toEqual({ items: [] });
  });
});

describe('serializeItems', () => {
  it('round-trips through parseItems', () => {
    const doc = parseItems(SAMPLE);
    expect(parseItems(serializeItems(doc))).toEqual(doc);
  });

  it('writes Out lines after the Claude and You lines', () => {
    const doc = { items: [item({ n: 2, title: 'A', lines: [{ by: 'claude', text: 'q' }], outputs: ['src/a.ts', 'mocks/b.png'] })] };
    expect(serializeItems(doc)).toBe('- [ ] #2 A\n      Claude: q\n      Out: src/a.ts\n      Out: mocks/b.png\n');
  });

  it('round-trips notes, outputs, empty lines and an untitled doc', () => {
    const doc = {
      items: [
        item({ n: 7, title: '', notes: ['a note'], lines: [{ by: 'claude', text: 'q' }, { by: 'you', text: '' }], outputs: ['src/a.ts'] }),
        item({ n: 8, title: 'Done one', done: true }),
      ],
    };
    const text = serializeItems(doc);
    expect(text.endsWith('\n')).toBe(true);
    expect(parseItems(text)).toEqual(doc);
  });
});

describe('withDecisions', () => {
  it('adds a You line after the last line of each item and leaves the rest as it was', () => {
    const out = withDecisions(SAMPLE, [
      { n: 2, text: 'Yes, the header too' },
      { n: 1, text: 'Thanks' },
    ]);
    expect(out).toBe(
      [
        '# Items · checkout review',
        '',
        '- [ ] #2 Sidebar rows too tight',
        '      Claude: 44px rows with 12px gaps, or 40px with 8px to fit six rows?',
        '      You: 44 / 12',
        '      Claude: Done for the list. The header too?',
        '      You: Yes, the header too',
        '- [x] #1 Pay button above the fold',
        '      Claude: done · moved into the first screen · mocks/checkout-v2.png',
        '      You: Thanks',
        '',
      ].join('\n'),
    );
  });

  it('adds the You line after Out lines and keeps them', () => {
    const text = ['- [ ] #1 A', '      Claude: q', '      Out: src/a.ts', '- [ ] #2 B', ''].join('\n');
    const out = withDecisions(text, [{ n: 1, text: 'yes' }]);
    expect(out).toBe(['- [ ] #1 A', '      Claude: q', '      Out: src/a.ts', '      You: yes', '- [ ] #2 B', ''].join('\n'));
    expect(parseItems(out).items[0]).toMatchObject({ outputs: ['src/a.ts'], lines: [{ by: 'claude' }, { by: 'you', text: 'yes' }] });
  });

  it('returns the text unchanged with nothing to add', () => {
    expect(withDecisions(SAMPLE, [])).toBe(SAMPLE);
    expect(withDecisions(SAMPLE, [{ n: 9, text: 'no such item' }])).toBe(SAMPLE);
  });

  it('fills a trailing empty You line', () => {
    const text = ['- [ ] #1 A', '      Claude: q', '      You:', '- [ ] #2 B', ''].join('\n');
    expect(withDecisions(text, [{ n: 1, text: 'yes' }])).toBe(['- [ ] #1 A', '      Claude: q', '      You: yes', '- [ ] #2 B', ''].join('\n'));
  });

  it('inserts before blank lines that end the block', () => {
    const text = ['- [ ] #1 A', '      Claude: q', '', '', 'Footer', ''].join('\n');
    expect(withDecisions(text, [{ n: 1, text: 'yes' }])).toBe(
      ['- [ ] #1 A', '      Claude: q', '      You: yes', '', '', 'Footer', ''].join('\n'),
    );
  });

  it('adds under an item with no lines, at the end of a file with no final newline', () => {
    expect(withDecisions('- [ ] #1 A', [{ n: 1, text: 'go' }])).toBe('- [ ] #1 A\n      You: go');
  });

  it('follows the indent the item already uses', () => {
    const text = ['- [ ] #1 A', '  Claude: q', '- [ ] #2 B', '\tClaude: r', '- [ ] #3 C', ''].join('\n');
    const out = withDecisions(text, [
      { n: 1, text: 'one' },
      { n: 2, text: 'two' },
      { n: 3, text: 'three' },
    ]);
    expect(out).toBe(
      ['- [ ] #1 A', '  Claude: q', '  You: one', '- [ ] #2 B', '\tClaude: r', '\tYou: two', '- [ ] #3 C', '      You: three', ''].join('\n'),
    );
  });

  it('keeps CRLF line endings and adds CRLF lines', () => {
    const crlf = SAMPLE.replace(/\n/g, '\r\n');
    const out = withDecisions(crlf, [{ n: 1, text: 'ok' }]);
    expect(out).toBe(withDecisions(SAMPLE, [{ n: 1, text: 'ok' }]).replace(/\n/g, '\r\n'));

    const empty = '- [ ] #1 A\r\n      You:\r\n';
    expect(withDecisions(empty, [{ n: 1, text: 'yes' }])).toBe('- [ ] #1 A\r\n      You: yes\r\n');
  });

  it('trims a decision and keeps it on one line', () => {
    expect(withDecisions('- [ ] #1 A\n', [{ n: 1, text: '  first\n\n second  ' }])).toBe('- [ ] #1 A\n      You: first second\n');
  });

  it('adds to the first of two items with the same number only', () => {
    expect(withDecisions('- [ ] #1 A\n- [ ] #1 B\n', [{ n: 1, text: 'x' }])).toBe('- [ ] #1 A\n      You: x\n- [ ] #1 B\n');
  });

  it('parses back with the decision as the latest You line', () => {
    const doc = parseItems(withDecisions(SAMPLE, [{ n: 2, text: 'header too' }]));
    expect(doc.items[0]!.lines.at(-1)).toEqual({ by: 'you', text: 'header too' });
    expect(awaitsUser(doc.items[0]!)).toBe(false);
  });
});

describe('decisionsDraft', () => {
  const doc = parseItems(SAMPLE);

  it('names one item', () => {
    expect(decisionsDraft('.feedback/items/s1.md', [{ n: 2, text: ' 44 / 12 ' }], doc)).toBe(
      'Decisions on an item in .feedback/items/s1.md:\n#2 Sidebar rows too tight: 44 / 12',
    );
  });

  it('lists several, and copes with unknown titles', () => {
    expect(
      decisionsDraft('.feedback/items/s1.md', [
        { n: 1, text: 'ok' },
        { n: 5, text: 'new\nidea' },
      ], doc),
    ).toBe('Decisions on 2 items in .feedback/items/s1.md:\n#1 Pay button above the fold: ok\n#5: new idea');
    expect(decisionsDraft('x.md', [{ n: 2, text: 'y' }], { items: [] })).toBe('Decisions on an item in x.md:\n#2: y');
  });
});

describe('awaitsUser', () => {
  it('waits on the user when Claude spoke last on an open item', () => {
    expect(awaitsUser(item({ lines: [{ by: 'claude', text: 'q' }] }))).toBe(true);
    expect(awaitsUser(item({ lines: [{ by: 'claude', text: 'q' }, { by: 'you', text: 'a' }] }))).toBe(false);
    expect(awaitsUser(item({ done: true, lines: [{ by: 'claude', text: 'q' }] }))).toBe(false);
    expect(awaitsUser(item({}))).toBe(false);
  });
});
