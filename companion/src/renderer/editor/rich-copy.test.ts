import { describe, expect, it } from 'vitest';
import { markdownToHtml, plainCopy, richCopy } from './rich-copy';

const html = (markdown: string, pictures?: Record<string, string>) => markdownToHtml(markdown, pictures).replace('<meta charset="utf-8">', '');

describe('markdownToHtml', () => {
  it('keeps inline marks, with a link outermost', () => {
    expect(html('Hi **bold**, *it*, ~~gone~~, `code` and [**docs**](https://example.com).')).toBe(
      '<p>Hi <strong>bold</strong>, <em>it</em>, <s>gone</s>, <code>code</code> and <a href="https://example.com"><strong>docs</strong></a>.</p>',
    );
  });

  it('draws headings, quotes, rules and code', () => {
    expect(html('# Title\n\n> said\n\n---\n\n```ts\nif (a < b) {}\n```')).toBe(
      '<h1>Title</h1><blockquote><p>said</p></blockquote><hr><pre><code>if (a &lt; b) {}</code></pre>',
    );
  });

  it('keeps lists tight, nested lists inside their item, and a numbered list start', () => {
    expect(html('- one\n  - inner\n- two\n\n3. three\n4. four')).toBe(
      '<ul><li>one<ul><li>inner</li></ul></li><li>two</li></ul><ol start="3"><li>three</li><li>four</li></ol>',
    );
  });

  it('draws task items with boxes', () => {
    expect(html('- [ ] open\n- [x] done')).toBe('<ul><li>☐ open</li><li>☑ done</li></ul>');
  });

  it('draws tables', () => {
    expect(html('| A | B |\n|---|---|\n| 1 | 2 |')).toBe('<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>');
  });

  it('turns a picture into its data URL, or its alt text when it is missing', () => {
    expect(html('![shot](att:abc123)', { abc123: 'data:image/png;base64,AAAA' })).toBe('<img src="data:image/png;base64,AAAA" alt="shot">');
    expect(html('![shot](att:abc123)')).toBe('<p>shot</p>');
  });

  it('escapes text and drops links that are not web or mail', () => {
    expect(html('a <b> & [x](javascript:alert(1))')).not.toContain('<b>');
    expect(html('[x](javascript:alert(1))')).not.toContain('href');
    expect(html('[mail](mailto:a@b.co)')).toContain('href="mailto:a@b.co"');
  });

  it('starts with a charset so pasted text keeps its accents', () => {
    expect(markdownToHtml('café')).toBe('<meta charset="utf-8"><p>café</p>');
  });
});

describe('plainCopy', () => {
  it('is the Markdown, with panel-only picture references cut to their alt text', () => {
    expect(plainCopy('Hi **team**\n\n![shot](att:abc123)\n\n\n\nBye')).toBe('Hi **team**\n\nshot\n\nBye');
  });

  it('pairs with the HTML in one value', () => {
    expect(richCopy('*x*')).toEqual({ html: '<meta charset="utf-8"><p><em>x</em></p>', text: '*x*' });
  });
});
