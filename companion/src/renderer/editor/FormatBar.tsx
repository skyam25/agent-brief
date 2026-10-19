/** Formatting over a text selection: the block type, then bold, italic, strike, code and link. */

import type { Editor } from '@tiptap/core';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import { useEditorState } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useEscape } from '../hooks';
import { ChevronIcon, CommentIcon, LinkIcon } from '../Icons';
import { CodeIcon } from './icons';

/** A bare domain gets https; anything with a scheme, a path or an anchor stays. */
export function normalizeHref(raw: string): string {
  const href = raw.trim();
  if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href) || /^[/#.]/.test(href)) return href;
  return /^[\w-]+(\.[\w-]+)+/.test(href) ? `https://${href}` : href;
}

const OPTIONS = { placement: 'top' as const, offset: 8, flip: true, shift: { padding: 8 } };

/** A block type the selection can turn into. Each one first lifts the selection out of lists and quotes. */
interface BlockKind {
  key: string;
  title: string;
  glyph: string;
  turn: (e: Editor) => void;
}

export const BLOCK_KINDS: BlockKind[] = [
  { key: 'text', title: 'Text', glyph: 'T', turn: (e) => e.chain().focus().clearNodes().run() },
  { key: 'h1', title: 'Heading 1', glyph: 'H1', turn: (e) => e.chain().focus().clearNodes().setHeading({ level: 1 }).run() },
  { key: 'h2', title: 'Heading 2', glyph: 'H2', turn: (e) => e.chain().focus().clearNodes().setHeading({ level: 2 }).run() },
  { key: 'h3', title: 'Heading 3', glyph: 'H3', turn: (e) => e.chain().focus().clearNodes().setHeading({ level: 3 }).run() },
  { key: 'bullet', title: 'Bulleted list', glyph: '•', turn: (e) => e.chain().focus().clearNodes().toggleBulletList().run() },
  { key: 'ordered', title: 'Numbered list', glyph: '1.', turn: (e) => e.chain().focus().clearNodes().toggleOrderedList().run() },
  { key: 'todo', title: 'To-do list', glyph: '☐', turn: (e) => e.chain().focus().clearNodes().toggleTaskList().run() },
  { key: 'quote', title: 'Quote', glyph: '❝', turn: (e) => e.chain().focus().clearNodes().toggleBlockquote().run() },
  { key: 'code', title: 'Code', glyph: '{ }', turn: (e) => e.chain().focus().clearNodes().setCodeBlock().run() },
];

/** The block kind at the selection. The innermost wrapper wins, so a heading in a quote reads as a heading. */
function kindAt(e: Editor): string {
  for (const level of [1, 2, 3] as const) if (e.isActive('heading', { level })) return `h${level}`;
  if (e.isActive('taskList')) return 'todo';
  if (e.isActive('bulletList')) return 'bullet';
  if (e.isActive('orderedList')) return 'ordered';
  if (e.isActive('blockquote')) return 'quote';
  return 'text';
}

/** The list under the block-type button. Escape or a pick closes it. */
function KindMenu(props: { current: string; onPick: (kind: BlockKind) => void; onClose: () => void }) {
  useEscape(props.onClose);
  return (
    <div className="kind-menu" role="menu" aria-label="Turn into" data-escape-owner data-testid="kind-menu">
      {BLOCK_KINDS.map((k) => (
        <button
          key={k.key}
          type="button"
          role="menuitemradio"
          aria-checked={k.key === props.current}
          className="kind-row"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => props.onPick(k)}
          data-testid="kind-item"
          data-key={k.key}
        >
          <span className="kind-glyph" aria-hidden="true">
            {k.glyph}
          </span>
          {k.title}
        </button>
      ))}
    </div>
  );
}

/** `onComment` adds a Comment button that marks the selection for a comment. */
export function FormatBar(props: { editor: Editor; onComment?: () => void }) {
  const { editor } = props;
  const [linking, setLinking] = useState(false);
  const [href, setHref] = useState('');
  const [kinds, setKinds] = useState(false);
  const linkingRef = useRef(false);
  linkingRef.current = linking;

  const active = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      strike: e.isActive('strike'),
      code: e.isActive('code'),
      link: e.isActive('link'),
      kind: kindAt(e),
    }),
  });

  // A new selection closes the block-type list.
  useEffect(() => {
    const close = () => setKinds(false);
    editor.on('selectionUpdate', close);
    return () => {
      editor.off('selectionUpdate', close);
    };
  }, [editor]);

  const shouldShow = useCallback(({ editor: e, state, view }: { editor: Editor; state: Editor['state']; view: Editor['view'] }) => {
    if (linkingRef.current) return true;
    const sel = state.selection;
    if (!e.isEditable || sel.empty || !(sel instanceof TextSelection) || sel instanceof NodeSelection) return false;
    if (sel.$from.parent.type.spec.code || !state.doc.textBetween(sel.from, sel.to).trim()) return false;
    return view.hasFocus();
  }, []);

  // The view takes focus at once. TipTap's own focus waits a frame, and a key typed meanwhile is lost.
  const closeLink = (refocus: boolean) => {
    if (refocus) editor.view.focus();
    setLinking(false);
  };
  const saveLink = () => {
    const url = normalizeHref(href);
    editor.view.focus();
    const chain = editor.chain().extendMarkRange('link');
    if (url) chain.setLink({ href: url }).run();
    else chain.unsetLink().run();
    setLinking(false);
  };

  const button = (name: 'bold' | 'italic' | 'strike' | 'code' | 'link', label: string, keys: string | undefined, icon: ReactNode, toggle: () => void) => (
    <button
      type="button"
      className="format-button"
      aria-label={label}
      title={keys ? `${label} (${keys})` : label}
      aria-pressed={active[name]}
      onMouseDown={(e) => e.preventDefault()}
      onClick={toggle}
      data-testid={`format-${name}`}
    >
      {icon}
    </button>
  );

  return (
    <BubbleMenu
      editor={editor}
      pluginKey="formatBar"
      shouldShow={shouldShow}
      options={OPTIONS}
      className="format-bar"
      data-testid="format-bar"
      data-escape-owner={linking || kinds || undefined}
    >
      {linking ? (
        <form
          className="format-link"
          onSubmit={(e) => {
            e.preventDefault();
            saveLink();
          }}
        >
          <input
            autoFocus
            type="text"
            placeholder="Paste a link"
            aria-label="Link address"
            value={href}
            onChange={(e) => setHref(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                closeLink(true);
              }
            }}
            onBlur={() => closeLink(false)}
            data-testid="format-link-input"
          />
          {active.link && (
            <button
              type="button"
              className="format-button text"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                editor.view.focus();
                editor.chain().extendMarkRange('link').unsetLink().run();
                setLinking(false);
              }}
              data-testid="format-link-remove"
            >
              Remove
            </button>
          )}
        </form>
      ) : (
        <>
          <button
            type="button"
            className="format-button kind-button"
            aria-label="Turn into"
            aria-haspopup="menu"
            aria-expanded={kinds}
            title="Turn into"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setKinds((open) => !open)}
            data-testid="format-kind"
          >
            <span className="glyph small">{BLOCK_KINDS.find((k) => k.key === active.kind)?.title}</span>
            <ChevronIcon />
          </button>
          {kinds && (
            <KindMenu
              current={active.kind}
              onClose={() => setKinds(false)}
              onPick={(k) => {
                k.turn(editor);
                setKinds(false);
              }}
            />
          )}
          <span className="format-sep" aria-hidden="true" />
          {button('bold', 'Bold', '⌘B', <b className="glyph">B</b>, () => editor.chain().focus().toggleBold().run())}
          {button('italic', 'Italic', '⌘I', <i className="glyph serif">I</i>, () => editor.chain().focus().toggleItalic().run())}
          {button('strike', 'Strikethrough', '⌘⇧X', <s className="glyph">S</s>, () => editor.chain().focus().toggleStrike().run())}
          {button('code', 'Code', '⌘E', <CodeIcon />, () => editor.chain().focus().toggleCode().run())}
          <span className="format-sep" aria-hidden="true" />
          {button('link', 'Link', undefined, <LinkIcon />, () => {
            setHref((editor.getAttributes('link').href as string | undefined) ?? '');
            setLinking(true);
          })}
          {props.onComment && (
            <>
              <span className="format-sep" aria-hidden="true" />
              <button
                type="button"
                className="format-button"
                aria-label="Comment"
                title="Comment on this passage"
                onMouseDown={(e) => e.preventDefault()}
                onClick={props.onComment}
                data-testid="format-comment"
              >
                <CommentIcon />
              </button>
            </>
          )}
        </>
      )}
    </BubbleMenu>
  );
}
