/** Inline formatting over a text selection: bold, italic, strike, code and link. */

import type { Editor } from '@tiptap/core';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import { useEditorState } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import { useCallback, useRef, useState, type ReactNode } from 'react';
import { LinkIcon } from '../Icons';
import { CodeIcon } from './icons';

/** A bare domain gets https; anything with a scheme, a path or an anchor stays. */
export function normalizeHref(raw: string): string {
  const href = raw.trim();
  if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href) || /^[/#.]/.test(href)) return href;
  return /^[\w-]+(\.[\w-]+)+/.test(href) ? `https://${href}` : href;
}

const OPTIONS = { placement: 'top' as const, offset: 8, flip: true, shift: { padding: 8 } };

export function FormatBar(props: { editor: Editor }) {
  const { editor } = props;
  const [linking, setLinking] = useState(false);
  const [href, setHref] = useState('');
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
    }),
  });

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

  const button = (name: keyof typeof active, label: string, keys: string | undefined, icon: ReactNode, toggle: () => void) => (
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
      data-escape-owner={linking || undefined}
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
          {button('bold', 'Bold', '⌘B', <b className="glyph">B</b>, () => editor.chain().focus().toggleBold().run())}
          {button('italic', 'Italic', '⌘I', <i className="glyph serif">I</i>, () => editor.chain().focus().toggleItalic().run())}
          {button('strike', 'Strikethrough', '⌘⇧X', <s className="glyph">S</s>, () => editor.chain().focus().toggleStrike().run())}
          {button('code', 'Code', '⌘E', <CodeIcon />, () => editor.chain().focus().toggleCode().run())}
          <span className="format-sep" aria-hidden="true" />
          {button('link', 'Link', undefined, <LinkIcon />, () => {
            setHref((editor.getAttributes('link').href as string | undefined) ?? '');
            setLinking(true);
          })}
        </>
      )}
    </BubbleMenu>
  );
}
