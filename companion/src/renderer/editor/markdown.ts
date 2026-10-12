/** The editor's schema as Markdown, with escaping kept light because the Markdown is a prompt. */

import { Extension, type AnyExtension, type JSONContent } from '@tiptap/core';
import Image from '@tiptap/extension-image';
import { renderTableToMarkdown, Table, TableKit } from '@tiptap/extension-table';
import TaskItem from '@tiptap/extension-task-item';
import TaskList from '@tiptap/extension-task-list';
import type { MarkdownManager } from '@tiptap/markdown';
import StarterKit from '@tiptap/starter-kit';
import { ListDepthFormats, NumberedList } from './lists';

const SLOT = /\{\{[^{}\n]{1,80}\}\}/g;

/** The stock table renderer wraps the table in newlines, which leaves extra blank lines around it. */
const PromptTable = Table.extend({
  renderMarkdown: (node, h) => renderTableToMarkdown(node, h).replace(/^\n+|\n+$/g, ''),
});

/** The blocks and marks a draft can hold. `image` is the picture node, which the editor gives a view. */
export function schemaExtensions(image: AnyExtension = Image): AnyExtension[] {
  return [
    StarterKit.configure({
      underline: false,
      heading: { levels: [1, 2, 3] },
      orderedList: false,
      link: { openOnClick: false, autolink: true, linkOnPaste: true, defaultProtocol: 'https' },
    }),
    NumberedList,
    ListDepthFormats,
    TableKit.configure({ table: false }),
    PromptTable.configure({ resizable: false }),
    TaskList,
    TaskItem.configure({ nested: true }),
    image,
  ];
}

const isWordChar = (c: string | undefined) => !!c && /[\p{L}\p{N}]/u.test(c);
const isBlank = (c: string | undefined) => c === undefined || /\s/.test(c);

/**
 * Escapes only what would change meaning when the Markdown is parsed again.
 * `snake_case`, `a * b`, `~/path` and `<Tag>` stay as typed.
 */
export function escapeProse(text: string, lineStart: boolean): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    const prev = text[i - 1];
    const next = text[i + 1];
    let escape = false;
    if (c === '\\') escape = !!next && /[!-/:-@[-`{-~]/.test(next);
    else if (c === '`') escape = true;
    else if (c === '*') escape = !(isBlank(prev) && isBlank(next));
    else if (c === '_') escape = !(isWordChar(prev) && isWordChar(next)) && !(isBlank(prev) && isBlank(next));
    else if (c === '~') escape = !isBlank(next) && next !== '/';
    else if (c === ']') escape = next === '(' || next === '[' || next === ':';
    else if (c === '&') {
      if (/^&#?\w+;/.test(text.slice(i))) {
        out += '&amp;';
        continue;
      }
    }
    out += escape ? `\\${c}` : c;
  }
  return out.replace(
    /(^|\n)([ \t]*)(#{1,6}(?=\s|$)|>|[-+*](?=\s)|\d{1,9}[.)](?=\s)|\[[ xX]\](?=\s)|[-=]+[ \t]*(?=\n|$))/g,
    (m, nl: string, indent: string, marker: string, offset: number) => {
      if (offset === 0 && !nl && !lineStart) return m;
      // A backslash before a digit is no escape, so a numbered marker escapes its dot.
      const escaped = /^\d/.test(marker) ? `${marker.slice(0, -1)}\\${marker.slice(-1)}` : `\\${marker}`;
      return `${nl}${indent}${escaped}`;
    },
  );
}

/** Text inside `{{slots}}` passes through untouched. */
function escapeOutsideSlots(text: string, lineStart: boolean): string {
  let out = '';
  let pos = 0;
  for (const m of text.matchAll(SLOT)) {
    out += escapeProse(text.slice(pos, m.index), lineStart && pos === 0) + m[0];
    pos = m.index + m[0].length;
  }
  return out + escapeProse(text.slice(pos), lineStart && pos === 0);
}

/** Swaps the manager's text escaping for `escapeProse`. Code keeps its text verbatim. */
export function lightenEscapes(manager: MarkdownManager): void {
  const codeTypes = (manager as unknown as { codeTypes: Set<string> }).codeTypes;
  const target = manager as unknown as {
    encodeTextForMarkdown: (text: string, node: JSONContent, parent?: JSONContent) => string;
  };
  target.encodeTextForMarkdown = (text, node, parent) => {
    const inCode = (parent?.type && codeTypes.has(parent.type)) || (node.marks ?? []).some((m) => codeTypes.has(m.type));
    if (inCode) return text;
    const siblings = parent?.content ?? [];
    const at = siblings.indexOf(node);
    const lineStart = at <= 0 || siblings[at - 1]?.type === 'hardBreak';
    return escapeOutsideSlots(text, lineStart);
  };
}

/** Runs after the Markdown extension and lightens its escaping. */
export const PromptMarkdown = Extension.create({
  name: 'promptMarkdown',
  priority: 50,
  onBeforeCreate() {
    if (this.editor.markdown) lightenEscapes(this.editor.markdown);
  },
});
