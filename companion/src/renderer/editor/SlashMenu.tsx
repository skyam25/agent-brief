/** The `/` menu. It inserts a block or a template where the slash was typed. */

import { Extension, type Editor, type Range } from '@tiptap/core';
import { PluginKey } from '@tiptap/pm/state';
import Suggestion, { type SuggestionProps } from '@tiptap/suggestion';
import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import type { Template } from '../../shared/ipc';

export interface SlashItem {
  key: string;
  group: 'Blocks' | 'Templates';
  title: string;
  hint: string;
  icon: ReactNode;
  /** Extra words the filter matches. */
  words?: string;
  run: (editor: Editor, range: Range) => void;
}

/** What the editor's React state does when the menu opens, moves, closes, or gets a key. */
export interface SlashBridge {
  open: (props: SuggestionProps<SlashItem, SlashItem>) => void;
  update: (props: SuggestionProps<SlashItem, SlashItem>) => void;
  close: () => void;
  keyDown: (event: KeyboardEvent) => boolean;
}

export const slashKey = new PluginKey('slash');

export function SlashCommand(bridge: SlashBridge) {
  return Extension.create({
    name: 'slashCommand',
    priority: 300,
    addProseMirrorPlugins() {
      return [
        Suggestion<SlashItem, SlashItem>({
          editor: this.editor,
          pluginKey: slashKey,
          char: '/',
          allowedPrefixes: [' '],
          floatingUi: { strategy: 'fixed' },
          offset: { mainAxis: 6 },
          items: () => [],
          allow: ({ state, range }) => !state.doc.resolve(range.from).parent.type.spec.code,
          command: ({ editor, range, props }) => props.run(editor, range),
          render: () => ({
            onStart: bridge.open,
            onUpdate: bridge.update,
            onExit: bridge.close,
            onKeyDown: ({ event }) => bridge.keyDown(event),
          }),
        }),
      ];
    },
  });
}

const glyph = (text: string, style?: CSSProperties) => (
  <span className="glyph" style={style}>
    {text}
  </span>
);

/** The block types. `pickImage` asks for a picture file. */
export function blockItems(pickImage: () => void): SlashItem[] {
  const block = (
    key: string,
    title: string,
    hint: string,
    icon: ReactNode,
    apply: (editor: Editor) => void,
    words = '',
  ): SlashItem => ({
    key,
    group: 'Blocks',
    title,
    hint,
    icon,
    words,
    run: (editor, range) => {
      editor.chain().focus().deleteRange(range).run();
      apply(editor);
    },
  });
  return [
    block('text', 'Text', 'Plain paragraph', glyph('T'), (e) => e.chain().focus().setParagraph().run(), 'paragraph'),
    block('h1', 'Heading 1', 'Big section title', glyph('H1'), (e) => e.chain().focus().setHeading({ level: 1 }).run(), 'title h1'),
    block('h2', 'Heading 2', 'Medium section title', glyph('H2'), (e) => e.chain().focus().setHeading({ level: 2 }).run(), 'subtitle h2'),
    block('h3', 'Heading 3', 'Small section title', glyph('H3'), (e) => e.chain().focus().setHeading({ level: 3 }).run(), 'h3'),
    block('bullet', 'Bulleted list', 'A simple list', glyph('•', { fontSize: 18 }), (e) => e.chain().focus().toggleBulletList().run(), 'ul unordered'),
    block('ordered', 'Numbered list', 'A list in order', glyph('1.'), (e) => e.chain().focus().toggleOrderedList().run(), 'ol ordered'),
    block('todo', 'To-do list', 'Tasks to tick off', glyph('☐'), (e) => e.chain().focus().toggleTaskList().run(), 'task checkbox'),
    block('quote', 'Quote', 'Quoted text', glyph('❝'), (e) => e.chain().focus().toggleBlockquote().run(), 'blockquote'),
    block('code', 'Code', 'A block of code', glyph('{ }'), (e) => e.chain().focus().toggleCodeBlock().run(), 'snippet'),
    block('divider', 'Divider', 'A line between sections', glyph('—'), (e) => e.chain().focus().setHorizontalRule().run(), 'hr rule separator'),
    block('table', 'Table', 'Rows and columns', glyph('⊞', { fontSize: 15 }), (e) =>
      e.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
    ),
    block('image', 'Image', 'A picture from a file', glyph('▣'), () => pickImage(), 'picture screenshot photo'),
  ];
}

/** Each template, inserted as blocks with its first slot selected. */
export function templateItems(templates: Template[], onInserted: (editor: Editor, from: number) => void): SlashItem[] {
  return templates.map((t) => ({
    key: `t:${t.id}`,
    group: 'Templates',
    title: t.title || 'Untitled template',
    hint: t.body.split('\n').find((l) => l.trim()) ?? '',
    icon: glyph('⧉'),
    words: t.id,
    run: (editor, range) => {
      editor.chain().focus().deleteRange(range).insertContent(t.body, { contentType: 'markdown' }).run();
      onInserted(editor, range.from);
    },
  }));
}

export function filterItems(items: SlashItem[], query: string): SlashItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter((i) => `${i.title} ${i.words ?? ''}`.toLowerCase().includes(q));
}

export function SlashMenu(props: { items: SlashItem[]; index: number; query: string; onPick: (item: SlashItem) => void; onHover: (index: number) => void }) {
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [props.index]);

  if (props.items.length === 0) {
    return (
      <div className="slash-popover" role="listbox" aria-label="Insert" data-escape-owner data-testid="slash-menu">
        <p className="muted empty">Nothing matches “{props.query}”.</p>
      </div>
    );
  }
  let group = '';
  return (
    <div className="slash-popover" ref={list} role="listbox" aria-label="Insert" data-escape-owner data-testid="slash-menu">
      {props.items.map((item, i) => {
        const head = item.group !== group ? (group = item.group) : undefined;
        return (
          <div key={item.key}>
            {head && <h4>{head}</h4>}
            <div
              className="slash-row"
              role="option"
              aria-selected={i === props.index}
              onMouseDown={(e) => {
                e.preventDefault();
                props.onPick(item);
              }}
              onMouseMove={() => i !== props.index && props.onHover(i)}
              data-testid="slash-item"
              data-key={item.key}
            >
              <span className="slash-icon" aria-hidden="true">
                {item.icon}
              </span>
              <span className="slash-text">
                <span className="slash-title">{item.title}</span>
                <span className="muted slash-hint">{item.hint}</span>
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
