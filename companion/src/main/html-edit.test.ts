import { describe, expect, it } from 'vitest';
import { annotate, applyEdit, cleanInline, EditError, editableOffsets, mergeStyle, parseStyle, versionOf } from './html-edit';

const PAGE = `<!doctype html>
<html>
<head><title>T</title><style>p { color: red }</style></head>
<body>
  <main class="stack" style="display: flex; gap: 8px">
    <h1>Pricing</h1>
    <p>Every plan</p>
    <button><svg width="12" height="12"><use href="#i"/></svg>Talk</button>
    <img src="a.png">
  </main>
  <footer>
    <span>Left</span>
  </footer>
</body>
</html>
`;

const at = (html: string, needle: string) => {
  const i = html.indexOf(needle);
  if (i < 0) throw new Error(`no ${needle}`);
  return i;
};

describe('annotate', () => {
  it('marks each body element with its start offset and leaves the head alone', () => {
    const out = annotate(PAGE);
    expect(out).toContain(`<main data-ab-at="${at(PAGE, '<main')}" class="stack"`);
    expect(out).toContain(`<h1 data-ab-at="${at(PAGE, '<h1>')}">Pricing</h1>`);
    expect(out).toContain(`<img data-ab-at="${at(PAGE, '<img')}" src="a.png">`);
    expect(out).toContain('<title>T</title>');
    expect(out).not.toContain('<body data-ab-at');
  });

  it('lists offsets in document order, svg children included', () => {
    const offsets = editableOffsets(PAGE);
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
    expect(offsets).toContain(at(PAGE, '<use'));
  });

  it('versions change with the text', () => {
    expect(versionOf(PAGE)).toBe(versionOf(PAGE));
    expect(versionOf(PAGE)).not.toBe(versionOf(`${PAGE} `));
  });
});

describe('styles', () => {
  it('keeps semicolons inside parentheses and quotes', () => {
    expect(parseStyle(`background: url("a;b.png"); color: rgb(1 2 3)`)).toEqual([
      ['background', 'url("a;b.png")'],
      ['color', 'rgb(1 2 3)'],
    ]);
  });

  it('sets, replaces and removes properties in place', () => {
    expect(mergeStyle('display: flex; gap: 8px', { gap: '12px', color: 'red', display: null })).toBe('gap: 12px; color: red');
  });
});

describe('applyEdit', () => {
  it('changes the words of a text element', () => {
    const out = applyEdit(PAGE, { kind: 'text', at: at(PAGE, '<h1>'), text: 'Plans & <prices>' });
    expect(out.html).toContain('<h1>Plans &amp; &lt;prices&gt;</h1>');
    expect(out.summary).toBe('Changed the text of h1 “Pricing” to “Plans & <prices>”');
  });

  it('writes a non-breaking space back as &nbsp;', () => {
    const page = '<body><p>Fish &amp; chips&nbsp;daily</p></body>';
    const out = applyEdit(page, { kind: 'text', at: at(page, '<p>'), text: 'Fish & chips\u00a0daily!' });
    expect(out.html).toContain('<p>Fish &amp; chips&nbsp;daily!</p>');
  });

  it('refuses to cut out an element with no end tag, and says why', () => {
    const page = '<body><div><p>No end tag\n</div></body>';
    expect(() => applyEdit(page, { kind: 'remove', at: at(page, '<p>') })).toThrow('p “No end tag” has no end tag in the file, so it can\'t be moved, copied or removed here');
  });

  it('changes the one text node of an element that also holds an icon', () => {
    const out = applyEdit(PAGE, { kind: 'text', at: at(PAGE, '<button>'), text: 'Stop' });
    expect(out.html).toContain('<use href="#i"/></svg>Stop</button>');
  });

  it('retypes words that hold inline tags, keeping their markup', () => {
    const page = '<body>\n  <p class="lede">Every <b>plan</b> has <a href="/x">exports</a>.</p>\n  <i>tail</i>\n</body>';
    const out = applyEdit(page, { kind: 'inline', at: at(page, '<p'), html: 'Each <b>plan</b> has <a href="/x">CSV exports</a> &amp; <em>more</em>.' });
    expect(out.html).toBe('<body>\n  <p class="lede">Each <b>plan</b> has <a href="/x">CSV exports</a> &amp; <em>more</em>.</p>\n  <i>tail</i>\n</body>');
    expect(out.summary).toBe('Changed the text of p “Every plan has exports .” to “Each plan has CSV exports & more.”');
    expect(editableOffsets(out.html)).toHaveLength(5);
  });

  it('refuses inline markup for an element that holds blocks', () => {
    const page = '<body><div>Lead <p>Block</p></div></body>';
    expect(() => applyEdit(page, { kind: 'inline', at: at(page, '<div>'), html: 'Lead' })).toThrow(EditError);
  });

  it('merges inline style, and adds the attribute when there is none', () => {
    const merged = applyEdit(PAGE, { kind: 'style', at: at(PAGE, '<main'), set: { gap: '16px' } });
    expect(merged.html).toContain('<main class="stack" style="display: flex; gap: 16px">');
    const added = applyEdit(PAGE, { kind: 'style', at: at(PAGE, '<p>'), set: { color: 'blue' } });
    expect(added.html).toContain('<p style="color: blue">Every plan</p>');
    const img = applyEdit(PAGE, { kind: 'style', at: at(PAGE, '<img'), set: { width: '40px' } });
    expect(img.html).toContain('<img src="a.png" style="width: 40px">');
  });

  it('removing the last property drops the style attribute', () => {
    const out = applyEdit(PAGE, { kind: 'style', at: at(PAGE, '<main'), set: { display: null, gap: null } });
    expect(out.html).toContain('<main class="stack">');
  });

  it('sets several attributes at once', () => {
    const out = applyEdit(PAGE, { kind: 'attrs', at: at(PAGE, '<main'), set: { 'data-x': '10', class: 'row' } });
    expect(out.html).toContain('<main class="row" style="display: flex; gap: 8px" data-x="10">');
  });

  it('moves an element before a sibling and keeps line breaks and indent', () => {
    const out = applyEdit(PAGE, { kind: 'move', at: at(PAGE, '<p>'), parent: at(PAGE, '<main'), before: at(PAGE, '<h1>') });
    expect(out.html).toContain('<main class="stack" style="display: flex; gap: 8px">\n    <p>Every plan</p>\n    <h1>Pricing</h1>\n    <button>');
    expect(out.html.slice(out.at!, out.at! + 3)).toBe('<p>');
    expect(out.summary).toBe('Moved p “Every plan” into main “Pricing Every plan Talk”, before h1 “Pricing”');
  });

  it('moves an element last into another container, at that container’s indent', () => {
    const out = applyEdit(PAGE, { kind: 'move', at: at(PAGE, '<h1>'), parent: at(PAGE, '<footer>'), before: null });
    expect(out.html).toContain('<footer>\n    <span>Left</span>\n    <h1>Pricing</h1>\n  </footer>');
    expect(out.html).not.toContain('<main class="stack" style="display: flex; gap: 8px">\n    <h1>');
    expect(out.html.slice(out.at!, out.at! + 4)).toBe('<h1>');
  });

  it('moves an element later in the same container', () => {
    const out = applyEdit(PAGE, { kind: 'move', at: at(PAGE, '<h1>'), parent: at(PAGE, '<main'), before: at(PAGE, '<img') });
    expect(out.html).toContain('<p>Every plan</p>\n    <button>');
    expect(out.html).toContain('</button>\n    <h1>Pricing</h1>\n    <img');
    expect(out.html.slice(out.at!, out.at! + 4)).toBe('<h1>');
  });

  it('refuses to move an element into itself', () => {
    expect(() => applyEdit(PAGE, { kind: 'move', at: at(PAGE, '<main'), parent: at(PAGE, '<main'), before: null })).toThrow(EditError);
  });

  it('refuses an element the file no longer has', () => {
    expect(() => applyEdit(PAGE, { kind: 'remove', at: 3 })).toThrow(/Reload the page/);
  });

  it('removes an element with its line', () => {
    const out = applyEdit(PAGE, { kind: 'remove', at: at(PAGE, '<p>') });
    expect(out.html).toContain('<h1>Pricing</h1>\n    <button>');
  });

  it('duplicates an element onto the next line', () => {
    const out = applyEdit(PAGE, { kind: 'duplicate', at: at(PAGE, '<span>') });
    expect(out.html).toContain('<span>Left</span>\n    <span>Left</span>\n  </footer>');
    expect(out.html.slice(out.at!, out.at! + 6)).toBe('<span>');
    expect(out.at).toBeGreaterThan(at(PAGE, '<span>'));
  });

  it('inserts ready-made markup last in a container', () => {
    const out = applyEdit(PAGE, { kind: 'insert', parent: at(PAGE, '<footer>'), before: null, what: 'button' });
    expect(out.html).toContain('<span>Left</span>\n    <button type="button">Button</button>\n  </footer>');
    expect(editableOffsets(out.html)).toContain(out.at);
  });

  it('keeps offsets consistent with a fresh annotation after each edit', () => {
    let html = PAGE;
    for (const edit of [
      { kind: 'duplicate', at: at(html, '<p>') },
      { kind: 'style', at: at(html, '<h1>'), set: { color: 'red' } },
    ] as const) {
      html = applyEdit(html, edit).html;
      const annotated = annotate(html);
      for (const o of editableOffsets(html)) expect(annotated).toContain(`data-ab-at="${o}"`);
    }
  });
});

describe('cleanInline', () => {
  it('keeps words and inline tags, and drops blocks, scripts, handlers and script links', () => {
    expect(cleanInline('<div>A <b onclick="x()">B</b></div><script>bad()</script><a href="javascript:x()">C</a> <a href="https://e.com" data-ab-at="4">D</a>')).toBe(
      'A <b>B</b><a>C</a> <a href="https://e.com">D</a>',
    );
    expect(cleanInline('One<br>two &lt;3&nbsp;!<!-- note -->')).toBe('One<br>two &lt;3&nbsp;!');
  });
});
