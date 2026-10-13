/** A draft as clipboard text: HTML for apps that paste formatting, Markdown for the rest. */

import type { JSONContent } from '@tiptap/core';
import { MarkdownManager } from '@tiptap/markdown';
import { imageRefs } from '../../shared/drafts';
import { schemaExtensions } from './markdown';

let manager: MarkdownManager | undefined;

/** Parses with the editor's schema, so the copy reads the Markdown as the editor does. */
const parse = (markdown: string): JSONContent => (manager ??= new MarkdownManager({ extensions: schemaExtensions() })).parse(markdown);

const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const SAFE_LINK = /^(https?:|mailto:)/i;

/** Code sits innermost and a link outermost, so a linked bold word stays one link. */
const MARK_ORDER = ['code', 'bold', 'italic', 'strike', 'link'];

type Mark = NonNullable<JSONContent['marks']>[number];

function wrap(html: string, mark: Mark): string {
  switch (mark.type) {
    case 'bold':
      return `<strong>${html}</strong>`;
    case 'italic':
      return `<em>${html}</em>`;
    case 'strike':
      return `<s>${html}</s>`;
    case 'code':
      return `<code>${html}</code>`;
    case 'link': {
      const href = String(mark.attrs?.href ?? '');
      return SAFE_LINK.test(href) ? `<a href="${escape(href)}">${html}</a>` : html;
    }
    default:
      return html;
  }
}

function text(node: JSONContent): string {
  const marks = [...(node.marks ?? [])].sort((a, b) => MARK_ORDER.indexOf(a.type) - MARK_ORDER.indexOf(b.type));
  return marks.reduce((html, mark) => wrap(html, mark), escape(node.text ?? ''));
}

class Writer {
  constructor(private readonly pictures: Record<string, string>) {}

  all(nodes: JSONContent[] | undefined): string {
    return (nodes ?? []).map((n) => this.node(n)).join('');
  }

  /** A list item's paragraphs draw inline, so pasted lists stay tight. */
  private item(node: JSONContent, lead = ''): string {
    const parts = (node.content ?? []).map((n) => (n.type === 'paragraph' ? this.all(n.content) : this.node(n)));
    return `<li>${lead}${parts.join('<br>').replace(/<br>(<[uo]l)/g, '$1')}</li>`;
  }

  private image(node: JSONContent): string {
    const src = String(node.attrs?.src ?? '');
    const alt = String(node.attrs?.alt ?? '');
    const data = src.startsWith('att:') ? this.pictures[src.slice(4)] : undefined;
    if (data) return `<img src="${escape(data)}" alt="${escape(alt)}">`;
    return alt ? `<p>${escape(alt)}</p>` : '';
  }

  node(node: JSONContent): string {
    const inner = () => this.all(node.content);
    switch (node.type) {
      case 'doc':
        return inner();
      case 'text':
        return text(node);
      case 'hardBreak':
        return '<br>';
      case 'paragraph':
        return `<p>${inner()}</p>`;
      case 'heading': {
        const level = Math.min(3, Math.max(1, Number(node.attrs?.level) || 1));
        return `<h${level}>${inner()}</h${level}>`;
      }
      case 'blockquote':
        return `<blockquote>${inner()}</blockquote>`;
      case 'codeBlock':
        return `<pre><code>${escape((node.content ?? []).map((n) => n.text ?? '').join(''))}</code></pre>`;
      case 'horizontalRule':
        return '<hr>';
      case 'bulletList':
        return `<ul>${(node.content ?? []).map((n) => this.item(n)).join('')}</ul>`;
      case 'orderedList': {
        const start = Number(node.attrs?.start ?? 1);
        return `<ol${start !== 1 ? ` start="${start}"` : ''}>${(node.content ?? []).map((n) => this.item(n)).join('')}</ol>`;
      }
      case 'taskList':
        return `<ul>${(node.content ?? []).map((n) => this.item(n, n.attrs?.checked ? '☑ ' : '☐ ')).join('')}</ul>`;
      case 'listItem':
      case 'taskItem':
        return this.item(node);
      case 'table':
        return `<table>${inner()}</table>`;
      case 'tableRow':
        return `<tr>${inner()}</tr>`;
      case 'tableHeader':
        return `<th>${(node.content ?? []).map((n) => (n.type === 'paragraph' ? this.all(n.content) : this.node(n))).join('<br>')}</th>`;
      case 'tableCell':
        return `<td>${(node.content ?? []).map((n) => (n.type === 'paragraph' ? this.all(n.content) : this.node(n))).join('<br>')}</td>`;
      case 'image':
        return this.image(node);
      default:
        return inner();
    }
  }
}

/** The draft's Markdown as HTML. `att:` pictures become their data URLs, or their alt text when missing. */
export function markdownToHtml(markdown: string, pictures: Record<string, string> = {}): string {
  return `<meta charset="utf-8">${new Writer(pictures).node(parse(markdown))}`;
}

/** The Markdown as plain text, without picture references only the panel can read. */
export function plainCopy(markdown: string): string {
  let out = markdown;
  for (const ref of imageRefs(markdown).reverse()) out = out.slice(0, ref.index) + ref.alt + out.slice(ref.index + ref.match.length);
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

/** Both forms, ready for one clipboard write. */
export function richCopy(markdown: string, pictures: Record<string, string> = {}): { html: string; text: string } {
  return { html: markdownToHtml(markdown, pictures), text: plainCopy(markdown) };
}
