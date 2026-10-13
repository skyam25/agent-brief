import { useEffect, useRef, useState } from 'react';
import type { BoardEntry, Draft } from '../shared/ipc';
import type { DraftBook } from './drafts';
import { FilingMenu, type FilingTab } from './FilingMenu';
import { DeleteItem, MoreMenu } from './FooterMenu';
import { CheckIcon, CopyIcon, LinkIcon, PlusIcon } from './Icons';
import { richCopy } from './editor/rich-copy';
import { RichEditor, type RichEditorHandle } from './editor/RichEditor';
import { newPictureId } from './editor/pictures';
import type { TemplateShelf } from './templates';

/** Names the open draft and saves it as a template. `onDone` gets the words to show, or nothing when cancelled. */
function TemplateNamer(props: { shelf: TemplateShelf; body: string; onDone: (message?: string) => void }) {
  const [name, setName] = useState('');
  const save = async () => {
    const title = name.trim();
    if (!title) return props.onDone();
    const created = await props.shelf.create(title, props.body);
    props.onDone(`Saved “${created.title}”`);
  };
  return (
    <span className="name-template" data-escape-owner>
      <input
        autoFocus
        placeholder="Template name"
        aria-label="Template name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void save();
          if (e.key === 'Escape') props.onDone();
        }}
        onBlur={() => props.onDone()}
        data-testid="save-template-name"
      />
    </span>
  );
}

const NO_PICTURES: Record<string, string> = {};

/** The open draft: its text, its board, where it is filed, Ready and Delete. */
export function DraftEditor(props: {
  book: DraftBook;
  shelf: TemplateShelf;
  draft: Draft;
  tabs: FilingTab[];
  onFile: (sessionId: string | undefined) => void;
  onFilingMenu?: () => void;
  listBoards: () => Promise<BoardEntry[]>;
  focusRequest: number;
  onSend: () => void;
  onOpenBoard: (board: string) => void;
  onCopy: (clip: { html: string; text: string }) => Promise<boolean>;
}) {
  const { book, draft } = props;
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = async () => {
    setCopied(await props.onCopy(richCopy(draft.body, draft.attachments)));
  };
  const editor = useRef<RichEditorHandle>(null);
  const [boards, setBoards] = useState<string[]>([]);
  const [naming, setNaming] = useState(false);
  const [saved, setSaved] = useState<string>();
  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(undefined), 2500);
    return () => clearTimeout(timer);
  }, [saved]);

  useEffect(() => {
    void props.listBoards().then((list) => setBoards(list.map((b) => b.name)));
  }, [props.listBoards]);

  useEffect(() => {
    editor.current?.focus();
  }, [props.focusRequest]);

  const ready = draft.status === 'ready';
  const onKeyDown = (e: globalThis.KeyboardEvent) => {
    if (e.key !== 'Enter' || !e.metaKey) return false;
    if (e.shiftKey) book.setReady(draft.id, !ready);
    else props.onSend();
    return true;
  };
  const attach = (dataUrl: string) => {
    const id = newPictureId();
    book.attach(draft.id, id, dataUrl);
    return id;
  };

  const boardOptions = draft.board && !boards.includes(draft.board) ? [draft.board, ...boards] : boards;

  return (
    <section className="editor">
      {draft.title && (
        <p className="draft-title" data-testid="draft-title">
          {draft.title}
        </p>
      )}
      {draft.source && (
        <p className="draft-source muted" data-testid="draft-source">
          From {draft.source.path}. Send asks Claude to apply your changes to the file.
        </p>
      )}
      <RichEditor
        editorRef={editor}
        testId="draft-body"
        label="Draft"
        placeholder={'Write a prompt or jot a note. Type / for blocks and templates.\n\n⌘↩ sends it. ⌘⇧↩ marks it Ready.'}
        value={draft.body}
        onChange={(body) => book.edit(draft.id, body)}
        attachments={draft.attachments ?? NO_PICTURES}
        onAttach={attach}
        onKeyDown={onKeyDown}
        templates={props.shelf.templates}
      />
      <footer>
        <label className="board-pick" title="A board whose sketch goes out with this draft">
          <LinkIcon />
          <select
            aria-label="Board"
            value={draft.board ?? ''}
            onChange={(e) => book.link(draft.id, e.target.value || undefined)}
            data-testid="draft-board"
          >
            <option value="">No board</option>
            {boardOptions.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </label>
        {draft.board && (
          <button className="ghost small link" onClick={() => props.onOpenBoard(draft.board!)} data-testid="draft-open-board">
            Open board
          </button>
        )}
        <FilingMenu draft={draft} tabs={props.tabs} onFile={props.onFile} onOpen={props.onFilingMenu} />
        <span className="spacer" />
        {(book.saveError || props.shelf.saveError) && (
          <span className="error" title={book.saveError ?? props.shelf.saveError} data-testid="save-error">
            Not saved yet. Retrying.
          </span>
        )}
        {naming ? (
          <TemplateNamer
            shelf={props.shelf}
            body={draft.body}
            onDone={(message) => {
              setNaming(false);
              setSaved(message);
            }}
          />
        ) : (
          saved && (
            <span className="muted" data-testid="save-template-done">
              {saved}
            </span>
          )
        )}
        <MoreMenu label="More for this note" testId="draft-more">
          {(close) => (
            <>
              <button
                className="ghost"
                role="menuitem"
                disabled={!draft.body.trim()}
                title="Keep this text as a template. Mark blanks with {{name}} first."
                onClick={() => {
                  close();
                  setSaved(undefined);
                  setNaming(true);
                }}
                data-testid="save-template"
              >
                <PlusIcon /> Save as template…
              </button>
              <DeleteItem what="note" testId="draft-delete" onDelete={() => book.remove(draft.id)} />
            </>
          )}
        </MoreMenu>
        <button
          className="ghost small copy-note"
          disabled={!draft.body.trim()}
          title="Copy as rich text, for Slack, Mail or Docs. Plain-text apps get the Markdown."
          onClick={() => void copy()}
          data-testid="draft-copy"
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button
          className={ready ? 'chip on' : 'chip'}
          aria-pressed={ready}
          title={ready ? 'Back to notes (⌘⇧↩)' : 'Queue it for sending (⌘⇧↩)'}
          onClick={() => book.setReady(draft.id, !ready)}
          data-testid="draft-ready"
        >
          {ready && <CheckIcon />}
          Ready
          <kbd>⌘⇧↩</kbd>
        </button>
      </footer>
    </section>
  );
}
