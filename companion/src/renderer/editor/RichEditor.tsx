/** The Write mode editor. Blocks and inline marks in, GitHub Markdown out. */

import type { Editor } from '@tiptap/core';
import Placeholder from '@tiptap/extension-placeholder';
import { NodeSelection } from '@tiptap/pm/state';
import { Markdown } from '@tiptap/markdown';
import { EditorContent, useEditor } from '@tiptap/react';
import type { SuggestionProps } from '@tiptap/suggestion';
import { useEffect, useImperativeHandle, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { NoteComment } from '../../shared/annotations';
import type { Template } from '../../shared/ipc';
import { Annotations, annotationsKey, passageAt, passageRange, type Passage } from './annotations';
import { BlockHandle, StarterChips } from './BlockHandle';
import { Find, findState } from './find';
import { FindBar, findIn } from './FindBar';
import { FormatBar } from './FormatBar';
import { ATT, AttachmentsContext, Picture } from './ImageView';
import { ListFormatMenu } from './ListFormatMenu';
import { numberedListAt, setListFormat, wordAt, type ListFormat } from './lists';
import { PromptMarkdown, schemaExtensions } from './markdown';
import { pictureFiles, preparePicture } from './pictures';
import { blockItems, filterItems, SlashCommand, SlashMenu, templateItems, type SlashBridge, type SlashItem } from './SlashMenu';
import { selectSlot, slotRanges, Slots } from './slots';
import { TableMenu } from './TableMenu';

export interface RichEditorHandle {
  focus(): void;
  /** Selects the first `{{slot}}`. False when there is none. */
  selectFirstSlot(): boolean;
  /** Scrolls a comment's passage into view. */
  reveal(comment: NoteComment): void;
  /** Opens the find bar with `query`, or the selected words, or the last query. */
  find(query?: string): void;
  /** Goes to the next or previous match. False when the find bar is closed. */
  findStep(dir: 1 | -1): boolean;
}

export interface RichEditorProps {
  /** Markdown. */
  value: string;
  onChange: (markdown: string) => void;
  /** Resolves `att:<id>` to a data URL for display. */
  attachments: Record<string, string>;
  /** A picture pasted or dropped in. Returns the id the Markdown references. */
  onAttach: (dataUrl: string) => string;
  templates: Template[];
  /** ⌘↩ and ⌘⇧↩ reach the owner. True means the owner handled the key. */
  onKeyDown?: (e: KeyboardEvent) => boolean | void;
  placeholder?: string;
  label: string;
  testId: string;
  editorRef?: RefObject<RichEditorHandle | null>;
  /** Comments to highlight, and the one in focus. */
  annotations?: { comments: NoteComment[]; activeId?: string };
  /** A passage to comment on, from the Comment button or a selection while annotating. Absent turns commenting off. */
  onAnnotate?: (passage: Passage) => void;
  /** True while a finished selection becomes a comment at once. */
  annotating?: boolean;
  onAnnotationClick?: (id: string) => void;
  /** Ids of comments whose passage is no longer in the note. */
  onAnnotationsMissing?: (ids: string[]) => void;
}

const NO_COMMENTS = { comments: [] };

/** Mounted editors by test id, so code outside React can select a slot. */
const live = new Map<string, RichEditorHandle>();

/**
 * Puts the cursor in an editor and selects its first slot. Waits a few
 * frames, since a new draft renders after this call.
 */
export function focusFirstSlot(testId: string, frames = 10): void {
  requestAnimationFrame(() => {
    const handle = live.get(testId);
    if (handle?.selectFirstSlot()) return;
    if (frames > 0) focusFirstSlot(testId, frames - 1);
    else handle?.focus();
  });
}

/** Opens an editor's find bar. Waits a few frames, since a note just opened renders after this call. */
export function openFind(testId: string, query?: string, frames = 10): void {
  requestAnimationFrame(() => {
    const handle = live.get(testId);
    if (handle) handle.find(query);
    else if (frames > 0) openFind(testId, query, frames - 1);
  });
}

/** Goes to an editor's next or previous match. False when its find bar is closed. */
export function stepFind(testId: string, dir: 1 | -1): boolean {
  return live.get(testId)?.findStep(dir) ?? false;
}

/**
 * Moves the cursor from a picture just put in to an empty paragraph below it,
 * so the next key types on instead of replacing the picture.
 */
function caretBelowPicture(editor: Editor): void {
  const { selection, doc } = editor.state;
  if (!(selection instanceof NodeSelection) || selection.node.type.name !== 'image') return;
  const pos = selection.to;
  const next = doc.resolve(pos).nodeAfter;
  const empty = next?.type.name === 'paragraph' && next.content.size === 0;
  const chain = editor.chain();
  if (!empty) chain.insertContentAt(pos, { type: 'paragraph' }, { updateSelection: false });
  chain.setTextSelection(pos + 1).scrollIntoView().run();
}

/** A right-click on a numbered list: where to show the menu, and which list it changes. */
interface ListMenuState {
  x: number;
  y: number;
  pos: number;
  current: ListFormat;
}

interface SlashState {
  host: HTMLElement;
  query: string;
  command: (item: SlashItem) => void;
  unmount: () => void;
}

export function RichEditor(props: RichEditorProps) {
  const latest = useRef(props);
  latest.current = props;
  /** The Markdown this editor last sent or took in. A different `value` comes from outside. */
  const known = useRef(props.value);
  /** The editor's own Markdown for the value it took in, until the person edits. */
  const loaded = useRef<string | undefined>(undefined);
  const fileInput = useRef<HTMLInputElement>(null);
  const editorBox = useRef<Editor | null>(null);
  const body = useRef<HTMLDivElement>(null);

  const [listMenu, setListMenu] = useState<ListMenuState | null>(null);
  const [finding, setFinding] = useState<{ seed: string; key: number }>();
  const [slash, setSlash] = useState<SlashState | null>(null);
  const [slashIndex, setSlashIndex] = useState(0);
  const slashRef = useRef<SlashState | null>(null);
  const items = useRef<SlashItem[]>([]);
  const index = useRef(0);

  const bridge = useRef<SlashBridge>({
    open: (p: SuggestionProps<SlashItem, SlashItem>) => {
      slashRef.current?.unmount();
      const host = document.createElement('div');
      host.className = 'slash-host';
      const s = { host, query: p.query, command: p.command, unmount: p.mount(host) };
      slashRef.current = s;
      setSlash(s);
      setSlashIndex(0);
    },
    update: (p) => {
      const prev = slashRef.current;
      if (!prev) return;
      if (prev.query !== p.query) setSlashIndex(0);
      slashRef.current = { ...prev, query: p.query, command: p.command };
      setSlash(slashRef.current);
    },
    close: () => {
      slashRef.current?.unmount();
      slashRef.current = null;
      setSlash(null);
    },
    keyDown: (e) => {
      const s = slashRef.current;
      const list = items.current;
      if (!s || list.length === 0 || e.metaKey || e.ctrlKey || e.altKey) return false;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const step = e.key === 'ArrowDown' ? 1 : -1;
        setSlashIndex((index.current + step + list.length) % list.length);
        return true;
      }
      if (e.key === 'Enter' || (e.key === 'Tab' && !e.shiftKey)) {
        s.command(list[index.current]!);
        return true;
      }
      return false;
    },
  }).current;

  /** Keeps each picture, then puts it at `at`, or at the cursor, with the cursor below it. */
  const insertPictures = async (files: File[], at?: number) => {
    for (const file of files) {
      const data = await preparePicture(file);
      const editor = editorBox.current;
      if (!data || !editor || editor.isDestroyed) continue;
      const id = latest.current.onAttach(data);
      const node = { type: 'image', attrs: { src: `${ATT}${id}`, alt: '' } };
      if (at === undefined) editor.chain().focus().insertContent(node).run();
      else editor.chain().focus().insertContentAt(Math.min(at, editor.state.doc.content.size), node).run();
      caretBelowPicture(editor);
      if (at !== undefined) at = editor.state.selection.from;
    }
  };

  const editor = useEditor(
    {
      immediatelyRender: true,
      shouldRerenderOnTransaction: false,
      content: props.value,
      contentType: 'markdown',
      extensions: [
        ...schemaExtensions(Picture),
        Markdown,
        PromptMarkdown,
        Placeholder.configure({ placeholder: () => latest.current.placeholder ?? '' }),
        Slots.configure({ skip: () => !!slashRef.current }),
        Find,
        SlashCommand(bridge),
        Annotations.configure({
          get: () => latest.current.annotations ?? NO_COMMENTS,
          onClick: (id) => latest.current.onAnnotationClick?.(id),
          onMissing: (ids) => latest.current.onAnnotationsMissing?.(ids),
          annotating: () => !!latest.current.annotating && !!latest.current.onAnnotate,
          onSelect: (passage) => latest.current.onAnnotate?.(passage),
        }),
      ],
      editorProps: {
        attributes: {
          class: 'rich-doc',
          role: 'textbox',
          'aria-label': props.label,
          'aria-multiline': 'true',
          'data-testid': props.testId,
          spellcheck: 'true',
        },
        handleKeyDown: (_view, event) => !!latest.current.onKeyDown?.(event),
        handleDOMEvents: {
          contextmenu: (view, event) => {
            const hit = view.posAtCoords({ left: event.clientX, top: event.clientY });
            const list = hit && numberedListAt(view.state, hit.pos);
            if (!list) return false;

            // A misspelled word gets the spelling menu instead.
            const word = wordAt(view.state, hit.pos);
            if (word && window.spelling?.isMisspelled(word)) return false;

            event.preventDefault();
            setListMenu({ x: event.clientX, y: event.clientY, pos: list.pos, current: list.format });
            return true;
          },
        },
        handlePaste: (_view, event) => {
          const files = pictureFiles(event.clipboardData?.files);
          if (files.length === 0) return false;
          event.preventDefault();
          void insertPictures(files);
          return true;
        },
        handleDrop: (view, event, _slice, moved) => {
          if (moved) return false;
          const files = pictureFiles(event.dataTransfer?.files);
          if (files.length === 0) return false;
          event.preventDefault();
          void insertPictures(files, view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos);
          return true;
        },
      },
      onUpdate: ({ editor: e }) => {
        const markdown = e.getMarkdown().trimEnd();
        if (markdown === known.current) return;

        // Reformatting what was loaded, such as adding the trailing paragraph, is no edit.
        if (markdown === loaded.current) return;
        loaded.current = undefined;
        known.current = markdown;
        latest.current.onChange(markdown);
      },
    },
    [],
  );
  if (editorBox.current !== editor) loaded.current = editor.getMarkdown().trimEnd();
  editorBox.current = editor;

  // A value from outside, such as a pulled-in note, replaces the content without taking focus.
  // It waits a microtask, because picture views render with flushSync, which React forbids during a commit.
  useEffect(() => {
    if (props.value === known.current) return;
    known.current = props.value;
    const value = props.value;
    queueMicrotask(() => {
      if (editor.isDestroyed || known.current !== value) return;
      editor.commands.setContent(value, { contentType: 'markdown', emitUpdate: false });
      loaded.current = editor.getMarkdown().trimEnd();
    });
  }, [editor, props.value]);

  // New comments, words or focus redraw the highlights.
  useEffect(() => {
    if (!editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta(annotationsKey, true));
  }, [editor, props.annotations]);

  const handle: RichEditorHandle = {
    focus: () => editor.commands.focus('end'),
    selectFirstSlot: () => selectSlot(editor, false, 0),
    reveal: (comment) => {
      const range = passageRange(editor.state.doc, comment.quote, comment.occurrence);
      if (!range) return;
      const { node } = editor.view.domAtPos(range.from);
      (node instanceof Element ? node : node.parentElement)?.scrollIntoView({ block: 'nearest' });
    },
    find: (query) => {
      const { from, to } = editor.state.selection;
      const selected = editor.state.doc.textBetween(from, to, '\n');
      const seed = query ?? (selected && !selected.includes('\n') ? selected : findState(editor.state).query);
      setFinding({ seed, key: Date.now() });
    },
    findStep: (dir) => {
      if (!findState(editor.state).query) return false;
      findIn(editor, { step: dir });
      return true;
    },
  };
  useImperativeHandle(props.editorRef, () => handle, [editor]);
  useEffect(() => {
    live.set(props.testId, handle);
    return () => {
      if (live.get(props.testId) === handle) live.delete(props.testId);
    };
  }, [editor, props.testId]);

  /** After a template goes in, select its first slot. */
  const selectInserted = (e: Editor, from: number) => {
    const end = e.state.selection.to;
    const slot = slotRanges(e.state.doc).find((s) => s.from >= from && s.to <= end);
    if (slot) e.chain().focus().setTextSelection(slot).scrollIntoView().run();
  };

  const shown = slash
    ? filterItems([...blockItems(() => fileInput.current?.click()), ...templateItems(props.templates, selectInserted)], slash.query)
    : [];
  items.current = shown;
  index.current = Math.min(slashIndex, Math.max(0, shown.length - 1));

  return (
    <div className="rich-editor">
      {finding && <FindBar editor={editor} seed={finding.seed} seedKey={finding.key} onClose={() => setFinding(undefined)} />}
      <div className="rich-body" ref={body}>
        <AttachmentsContext.Provider value={props.attachments}>
          <EditorContent editor={editor} className="rich-content" />
        </AttachmentsContext.Provider>
        <BlockHandle editor={editor} box={body} hidden={!!slash} />
        <StarterChips
          editor={editor}
          templates={props.templates}
          onPick={(t) => {
            editor.chain().focus('start').insertContent(t.body, { contentType: 'markdown' }).run();
            selectInserted(editor, 0);
          }}
        />
      </div>
      <FormatBar
        editor={editor}
        onComment={
          props.onAnnotate &&
          (() => {
            const { from, to } = editor.state.selection;
            const passage = passageAt(editor.state.doc, from, to);
            if (!passage) return;

            // The selection collapses, so the bar closes and the highlight shows.
            editor.commands.setTextSelection(to);
            latest.current.onAnnotate?.(passage);
          })
        }
      />
      <TableMenu editor={editor} />
      {listMenu && (
        <ListFormatMenu
          x={listMenu.x}
          y={listMenu.y}
          current={listMenu.current}
          onClose={() => setListMenu(null)}
          onPick={(format) => {
            setListMenu(null);

            // The list may have moved or gone since the right-click.
            const list = numberedListAt(editor.state, Math.min(listMenu.pos + 1, editor.state.doc.content.size));
            if (list?.pos === listMenu.pos) editor.view.dispatch(setListFormat(editor.state, list.pos, format));
            editor.view.focus();
          }}
        />
      )}
      <input
        ref={fileInput}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => {
          const files = pictureFiles(e.currentTarget.files);
          e.currentTarget.value = '';
          void insertPictures(files);
        }}
        data-testid="draft-image-input"
      />
      {slash &&
        createPortal(
          <SlashMenu items={shown} index={index.current} query={slash.query} onPick={(item) => slash.command(item)} onHover={setSlashIndex} />,
          slash.host,
        )}
    </div>
  );
}
