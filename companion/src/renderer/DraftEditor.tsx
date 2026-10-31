import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { hasAnnotations } from '../shared/annotations';
import type { BoardEntry, CompanionApi, Draft } from '../shared/ipc';
import { outlinePathFor } from '../shared/outline';
import type { DraftBook } from './drafts';
import { FileUnder, type FilingTab } from './FilingMenu';
import { DeleteItem, MoreMenu } from './FooterMenu';
import { CheckIcon, CopyIcon, LinkIcon, PlusIcon } from './Icons';
import { richCopy } from './editor/rich-copy';
import type { Passage } from './editor/annotations';
import { RichEditor, type RichEditorHandle } from './editor/RichEditor';
import { newPictureId } from './editor/pictures';
import { NoteComments } from './NoteComments';
import { sourceLine } from './outline-edit';
import { OVERALL, type ReviewVoice } from './review-voice';
import type { TemplateShelf } from './templates';
import { useStore } from './hooks';

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

/** The outline beside a note's source file, once a read finds it there. */
function useSourceOutline(host: Pick<CompanionApi, 'readOutline'>, sessionId: string | undefined, path: string | undefined): string | undefined {
  const [found, setFound] = useState<string>();
  useEffect(() => {
    setFound(undefined);
    if (!sessionId || !path) return;
    const outline = outlinePathFor(path);
    let live = true;
    host
      .readOutline(sessionId, outline)
      .then((doc) => live && doc.version !== 'missing' && setFound(outline))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [host, sessionId, path]);
  return found;
}

const newCommentId = () => `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

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
  /** Puts a line on the clipboard that a new session can pick the note up from. */
  onCopyReference: () => void;
  /** The target chip and Send, last in the footer. */
  sendBar?: ReactNode;
  /** The mic, which talks to this note's comments. */
  voice: ReviewVoice;
  /** The mic is on, so a selection becomes a comment at once. */
  talking: boolean;
  /** Finds an outline beside the note's source file. */
  outlineHost: Pick<CompanionApi, 'readOutline'>;
}) {
  const { book, draft, voice } = props;
  useStore(voice);
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

  useEffect(() => book.watchSource(draft.id), [book, draft.id, draft.sessionId, draft.source?.path]);
  const fileChanged = book.changedSource(draft.id) !== undefined;
  const sourceOutline = useSourceOutline(props.outlineHost, draft.sessionId, draft.source?.path);

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

  const [activeId, setActiveId] = useState<string>();
  const [missing, setMissing] = useState<string[]>([]);
  const comments = draft.annotations?.comments;
  const highlights = useMemo(() => ({ comments: comments ?? [], activeId }), [comments, activeId]);

  /** Puts a comment in focus, points the mic at it, and shows its passage. */
  const select = (id: string | undefined, focus = false) => {
    setActiveId(id);
    voice.aim(id ?? OVERALL);
    const comment = id ? book.get(draft.id)?.annotations?.comments.find((c) => c.id === id) : undefined;
    if (comment) editor.current?.reveal(comment);
    if (!id) return;
    requestAnimationFrame(() => {
      const card = document.querySelector(`[data-comment="${id}"]`);
      card?.scrollIntoView({ block: 'nearest' });
      if (focus) card?.querySelector('textarea')?.focus();
    });
  };

  /** A passage to comment on. One already commented on opens its comment. While talking, words fill it. */
  const annotate = (passage: Passage) => {
    const known = book.get(draft.id)?.annotations?.comments.find((c) => c.quote === passage.quote && c.occurrence === passage.occurrence);
    if (known) return select(known.id, !props.talking);
    const id = newCommentId();
    book.addNoteComment(draft.id, { id, ...passage, text: '', createdAt: Date.now() });
    select(id, !props.talking);
  };
  const removeComment = (id: string) => {
    book.removeNoteComment(draft.id, id);
    if (activeId === id) select(undefined);
  };
  const commentKeys = (e: ReactKeyboardEvent) => {
    if (e.key !== 'Enter' || !e.metaKey) return;
    e.preventDefault();
    props.onSend();
  };
  const showComments = props.talking || hasAnnotations(draft.annotations);

  const boardOptions = draft.board && !boards.includes(draft.board) ? [draft.board, ...boards] : boards;

  return (
    <section className={draft.title ? 'editor' : 'editor untitled'}>
      {draft.title && (
        <p className="draft-title" data-testid="draft-title">
          {draft.title}
        </p>
      )}
      {draft.source && (
        <p className="draft-source muted" data-testid="draft-source">
          {sourceLine(draft.source.path, sourceOutline)}
        </p>
      )}
      {draft.source && fileChanged && (
        <p className="draft-source-changed" role="status" data-testid="draft-source-changed">
          The file changed since you edited this note. Reload takes the file's text, and your comments stay.
          <button className="ghost small" onClick={() => book.reloadSource(draft.id)} data-testid="draft-source-reload">
            Reload
          </button>
        </p>
      )}
      <div className="note-work">
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
          annotations={highlights}
          onAnnotate={annotate}
          annotating={props.talking}
          onAnnotationClick={(id) => select(id)}
          onAnnotationsMissing={setMissing}
        />
        {showComments && (
          <NoteComments
            annotations={draft.annotations}
            activeId={activeId}
            missing={missing}
            voice={voice}
            talking={props.talking}
            onSelect={(id) => select(id)}
            onEdit={(id, text) => book.editNoteComment(draft.id, id, text)}
            onRemove={removeComment}
            onOverall={(text) => book.setOverall(draft.id, text)}
            onKeyDown={commentKeys}
          />
        )}
      </div>
      <footer>
        <label className={draft.board ? 'board-pick' : 'board-pick unset'} title="A board whose sketch goes out with this draft">
          <LinkIcon />
          <select
            aria-label="Board"
            value={draft.board ?? ''}
            onChange={(e) => book.link(draft.id, e.target.value || undefined)}
            data-testid="draft-board"
          >
            <option value="">Board</option>
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
              <FileUnder filed={draft.sessionId} tabs={props.tabs} onFile={props.onFile} onOpen={props.onFilingMenu} close={close} />
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
              <button
                className="ghost"
                role="menuitem"
                title="Copy a line to paste into any Claude Code session"
                onClick={() => {
                  close();
                  props.onCopyReference();
                }}
                data-testid="draft-copy-reference"
              >
                <LinkIcon /> Copy reference
              </button>
              <DeleteItem what="note" testId="draft-delete" onDelete={() => book.remove(draft.id)} />
            </>
          )}
        </MoreMenu>
        <button
          className="ghost small copy-note"
          aria-label={copied ? 'Copied' : 'Copy'}
          disabled={!draft.body.trim()}
          title="Copy as rich text, for Slack, Mail or Docs. Plain-text apps get the Markdown."
          onClick={() => void copy()}
          data-testid="draft-copy"
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
          <span className="label">{copied ? 'Copied' : 'Copy'}</span>
        </button>
        <button
          className={ready ? 'ghost small ready-toggle on' : 'ghost small ready-toggle'}
          aria-pressed={ready}
          title={ready ? 'Back to notes (⌘⇧↩)' : 'Queue it for sending (⌘⇧↩)'}
          onClick={() => book.setReady(draft.id, !ready)}
          data-testid="draft-ready"
        >
          {ready && <CheckIcon />}
          Ready
          <kbd>⌘⇧↩</kbd>
        </button>
        {props.sendBar}
      </footer>
    </section>
  );
}
