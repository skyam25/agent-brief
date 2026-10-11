import { useEffect, useRef, useState, useSyncExternalStore, type DragEvent, type KeyboardEvent } from 'react';
import { draftTitle } from '../shared/drafts';
import type { BoardEntry, Draft, Template } from '../shared/ipc';
import type { DraftBook } from './drafts';
import { CheckIcon, ChevronIcon, GripIcon, LinkIcon, PlusIcon, TrashIcon } from './Icons';
import { focusFirstSlot, SlotArea } from './SlotArea';
import type { TemplateShelf } from './templates';

export function useDrafts(book: DraftBook): DraftBook {
  useSyncExternalStore(
    (fn) => book.subscribe(fn),
    () => book.version,
  );
  return book;
}

/** Closes a menu on Escape. The menu carries `data-escape-owner`, so the panel stays up. */
export function useEscape(onClose: () => void): void {
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
}

export function useTemplates(shelf: TemplateShelf): TemplateShelf {
  useSyncExternalStore(
    (fn) => shelf.subscribe(fn),
    () => shelf.version,
  );
  return shelf;
}

/** `5m`, `3h`, or a date, for the list. */
export function ago(ms: number, now = Date.now()): string {
  const s = Math.max(0, (now - ms) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

const matches = (d: Draft, query: string) => !query || d.body.toLowerCase().includes(query.toLowerCase());

/** Write mode: Ready drafts, notes and templates on the left; the open one on the right. */
export function WriteView(props: {
  book: DraftBook;
  shelf: TemplateShelf;
  listBoards: () => Promise<BoardEntry[]>;
  /** Bumped to put the cursor in the editor. */
  focusRequest: number;
  onSend: () => void;
  onOpenBoard: (board: string) => void;
}) {
  const book = useDrafts(props.book);
  const shelf = useTemplates(props.shelf);
  const [query, setQuery] = useState('');
  const [templateId, setTemplateId] = useState<string>();
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [newMenu, setNewMenu] = useState(false);
  const selected = book.selected;
  const template = shelf.get(templateId);

  // Opening a draft from anywhere, such as the capture shortcut, closes the template.
  useEffect(() => {
    if (book.selectedId) setTemplateId(undefined);
  }, [book.selectedId]);

  const openDraft = (id: string) => {
    setTemplateId(undefined);
    book.select(id);
  };
  const openTemplate = (id: string) => {
    book.select(undefined);
    setTemplateId(id);
    setTemplatesOpen(true);
  };
  /** A new note from a template, with its first slot selected. */
  const useTemplate = (t: Template) => {
    setNewMenu(false);
    setTemplateId(undefined);
    book.create(t.body);
    focusFirstSlot('draft-body');
  };
  const newTemplate = async () => {
    setNewMenu(false);
    const created = await shelf.create('New template', '');
    openTemplate(created.id);
  };
  const ready = book.ready.filter((d) => matches(d, query));
  const notes = book.drafts.filter((d) => d.status === 'note' && matches(d, query) && (d.body.trim() || d.board || d.id === selected?.id));

  return (
    <div className="write" data-testid="write">
      <nav className="draft-list" aria-label="Drafts">
        <div className="list-head">
          <input
            type="search"
            placeholder="Search drafts"
            aria-label="Search drafts"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            data-testid="draft-search"
          />
          <div className="cluster split anchor">
            <button
              className="ghost icon-button"
              title="New note (⌘N)"
              aria-label="New note"
              onClick={() => {
                setTemplateId(undefined);
                book.create();
              }}
              data-testid="draft-new"
            >
              <PlusIcon />
            </button>
            <button
              className="ghost icon-button narrow"
              title="New from a template"
              aria-label="New from a template"
              aria-haspopup="menu"
              aria-pressed={newMenu}
              onClick={() => setNewMenu((o) => !o)}
              data-testid="draft-new-menu"
            >
              <ChevronIcon />
            </button>
            {newMenu && (
              <NewMenu templates={shelf.templates} onUse={useTemplate} onNewTemplate={() => void newTemplate()} onClose={() => setNewMenu(false)} />
            )}
          </div>
        </div>
        <div className="sections">
          <ReadyQueue book={book} drafts={ready} selectedId={selected?.id} reorder={!query} onOpen={openDraft} />
          <section>
            <h3>Notes</h3>
            {notes.length === 0 && <p className="muted empty">{query ? 'No notes match.' : 'Notes you jot down wait here until you send them.'}</p>}
            <ul>
              {notes.map((d) => (
                <DraftRow key={d.id} draft={d} selected={d.id === selected?.id} onSelect={() => openDraft(d.id)} />
              ))}
            </ul>
          </section>
          <section>
            <h3>
              <button
                className="ghost section-toggle"
                aria-expanded={templatesOpen}
                onClick={() => setTemplatesOpen((o) => !o)}
                data-testid="templates-toggle"
              >
                <span className="caret" aria-hidden="true">
                  {templatesOpen ? '▾' : '▸'}
                </span>
                Templates <span className="count">{shelf.templates.length || ''}</span>
              </button>
            </h3>
            {templatesOpen && (
              <ul data-testid="template-list">
                {shelf.templates.map((t) => (
                  <li key={t.id}>
                    <button
                      className="ghost draft-row"
                      aria-current={t.id === templateId}
                      onClick={() => openTemplate(t.id)}
                      data-testid="template-row"
                    >
                      <span className="lines">
                        <span>{t.title || 'Untitled template'}</span>
                        <span className="muted">{draftTitle(t.body) || 'Empty'}</span>
                      </span>
                    </button>
                  </li>
                ))}
                <li>
                  <button className="ghost link add-template" onClick={() => void newTemplate()} data-testid="template-new">
                    <PlusIcon /> New template
                  </button>
                </li>
              </ul>
            )}
          </section>
        </div>
      </nav>
      {template ? (
        <TemplateEditor
          key={template.id}
          shelf={shelf}
          template={template}
          onUse={() => useTemplate(template)}
          onDeleted={() => setTemplateId(undefined)}
        />
      ) : selected ? (
        <DraftEditor
          key={selected.id}
          book={book}
          shelf={shelf}
          draft={selected}
          listBoards={props.listBoards}
          focusRequest={props.focusRequest}
          onSend={props.onSend}
          onOpenBoard={props.onOpenBoard}
        />
      ) : (
        <div className="editor empty-editor">
          <p className="muted">Pick a draft, or start a note with ⌘N.</p>
        </div>
      )}
    </div>
  );
}

/** Ready drafts in send order. Drag the grip, or press ⌥↑ and ⌥↓, to reorder. */
function ReadyQueue(props: { book: DraftBook; drafts: Draft[]; selectedId?: string; reorder: boolean; onOpen: (id: string) => void }) {
  const { book } = props;
  const [dragging, setDragging] = useState<string>();
  const [dropAt, setDropAt] = useState<number>();

  /** Where a drop over row `i` lands, counted without the dragged draft. */
  const indexAt = (e: DragEvent, i: number) => {
    const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const after = e.clientY > box.top + box.height / 2;
    const from = props.drafts.findIndex((d) => d.id === dragging);
    const at = i + (after ? 1 : 0);
    return from !== -1 && from < at ? at - 1 : at;
  };

  const nudge = (e: KeyboardEvent, d: Draft, i: number) => {
    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    book.move(d.id, e.key === 'ArrowUp' ? i - 1 : i + 1);
  };

  return (
    <section>
      <h3>
        Ready <span className="count">{props.drafts.length || ''}</span>
      </h3>
      {props.drafts.length === 0 && <p className="muted empty">Mark a draft Ready (⌘⇧↩) to queue it for sending.</p>}
      <ul data-testid="ready-list" onDragLeave={() => setDropAt(undefined)}>
        {props.drafts.map((d, i) => (
          <DraftRow
            key={d.id}
            draft={d}
            selected={d.id === props.selectedId}
            onSelect={() => props.onOpen(d.id)}
            onKeyDown={props.reorder ? (e) => nudge(e, d, i) : undefined}
            drag={
              props.reorder
                ? {
                    dragging: dragging === d.id,
                    dropBefore: dropAt === i && dragging !== d.id,
                    onDragStart: (e) => {
                      e.dataTransfer.setData('text/plain', d.id);
                      e.dataTransfer.effectAllowed = 'move';
                      setDragging(d.id);
                    },
                    onDragEnd: () => {
                      setDragging(undefined);
                      setDropAt(undefined);
                    },
                    onDragOver: (e) => {
                      e.preventDefault();
                      const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
                      setDropAt(e.clientY > box.top + box.height / 2 ? i + 1 : i);
                    },
                    onDrop: (e) => {
                      e.preventDefault();
                      if (dragging) book.move(dragging, indexAt(e, i));
                      setDragging(undefined);
                      setDropAt(undefined);
                    },
                  }
                : undefined
            }
          />
        ))}
      </ul>
    </section>
  );
}

function DraftRow(props: {
  draft: Draft;
  selected: boolean;
  onSelect: () => void;
  onKeyDown?: (e: KeyboardEvent) => void;
  drag?: {
    dragging: boolean;
    dropBefore: boolean;
    onDragStart: (e: DragEvent) => void;
    onDragEnd: () => void;
    onDragOver: (e: DragEvent) => void;
    onDrop: (e: DragEvent) => void;
  };
}) {
  const { draft: d, drag } = props;
  const title = draftTitle(d.body) || 'Empty note';
  const rest = d.body.split('\n').filter((l) => l.trim())[1]?.trim();
  return (
    <li
      className={drag?.dropBefore ? 'drop-before' : undefined}
      draggable={!!drag}
      onDragStart={drag?.onDragStart}
      onDragEnd={drag?.onDragEnd}
      onDragOver={drag?.onDragOver}
      onDrop={drag?.onDrop}
      data-dragging={drag?.dragging || undefined}
    >
      <button
        className="ghost draft-row"
        aria-current={props.selected}
        onClick={props.onSelect}
        onKeyDown={props.onKeyDown}
        title={drag ? 'Drag, or press ⌥↑ and ⌥↓, to reorder' : undefined}
        data-testid="draft-row"
      >
        {drag && (
          <span className="grip" aria-hidden="true">
            <GripIcon />
          </span>
        )}
        <span className="lines">
          <span className={d.body.trim() ? undefined : 'muted'}>{title}</span>
          <span className="muted">
            {d.board && (
              <span className="board-tag" title={`Goes with the board ${d.board}`}>
                <LinkIcon /> {d.board}
              </span>
            )}
            {rest || ago(d.updatedAt)}
          </span>
        </span>
      </button>
    </li>
  );
}

/** Delete asks once more, then reverts after a few seconds. */
function DeleteButton(props: { what: string; onDelete: () => void; testId: string }) {
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    if (!confirm) return;
    const timer = setTimeout(() => setConfirm(false), 3000);
    return () => clearTimeout(timer);
  }, [confirm]);
  return (
    <button
      className={confirm ? 'ghost danger' : 'ghost icon-button'}
      title={`Delete this ${props.what}`}
      aria-label={confirm ? 'Confirm delete' : 'Delete'}
      onClick={() => (confirm ? props.onDelete() : setConfirm(true))}
      data-testid={props.testId}
    >
      {confirm ? 'Delete?' : <TrashIcon />}
    </button>
  );
}

/** Blank notes come from ⌘N; this menu starts one from a template. */
function NewMenu(props: { templates: Template[]; onUse: (t: Template) => void; onNewTemplate: () => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const anchor = ref.current?.parentElement;
      if (anchor && !anchor.contains(e.target as Node)) props.onClose();
    };
    window.addEventListener('pointerdown', onDown, { capture: true });
    return () => window.removeEventListener('pointerdown', onDown, { capture: true });
  }, [props.onClose]);
  useEscape(props.onClose);
  return (
    <div className="popover-panel new-menu" ref={ref} role="menu" aria-label="New from a template" data-escape-owner data-testid="new-menu">
      <h3>New from a template</h3>
      {props.templates.length === 0 && <p className="muted">No templates yet.</p>}
      <ul>
        {props.templates.map((t) => (
          <li key={t.id}>
            <button className="ghost" role="menuitem" onClick={() => props.onUse(t)} data-testid="new-menu-item">
              {t.title}
            </button>
          </li>
        ))}
      </ul>
      <button className="ghost link" onClick={props.onNewTemplate} data-testid="new-menu-template">
        <PlusIcon /> New template
      </button>
      <p className="muted hint">Or type / at the start of a line in any note.</p>
    </div>
  );
}

/** A template: its name and text. Use template starts a note from it. */
function TemplateEditor(props: { shelf: TemplateShelf; template: Template; onUse: () => void; onDeleted: () => void }) {
  const { shelf, template } = props;
  const title = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (template.title === 'New template') title.current?.select();
  }, []);
  return (
    <section className="editor template-editor" data-testid="template-editor">
      <input
        ref={title}
        className="template-title"
        aria-label="Template name"
        placeholder="Template name"
        value={template.title}
        onChange={(e) => shelf.edit(template.id, { title: e.target.value })}
        data-testid="template-title"
      />
      <SlotArea
        value={template.body}
        onChange={(body) => shelf.edit(template.id, { body })}
        label="Template"
        testId="template-body"
        placeholder={'Write the prompt. Mark each blank with {{a name}}.\n\nWhen you use the template, Tab jumps from blank to blank.'}
      />
      <footer>
        <span className="muted">
          Blanks look like <code>{'{{goal}}'}</code>
        </span>
        <span className="spacer" />
        {shelf.saveError && (
          <span className="error" title={shelf.saveError} data-testid="template-save-error">
            Not saved: {shelf.saveError}
          </span>
        )}
        <DeleteButton
          what="template"
          testId="template-delete"
          onDelete={() => {
            shelf.remove(template.id);
            props.onDeleted();
          }}
        />
        <button className="primary" onClick={props.onUse} data-testid="template-use">
          Use template
        </button>
      </footer>
    </section>
  );
}

/** Names the open draft and saves it as a template. */
function SaveAsTemplate(props: { shelf: TemplateShelf; body: string }) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [saved, setSaved] = useState<string>();
  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(undefined), 2500);
    return () => clearTimeout(timer);
  }, [saved]);

  const save = async () => {
    const title = name.trim();
    if (!title) return setNaming(false);
    const created = await props.shelf.create(title, props.body);
    setNaming(false);
    setName('');
    setSaved(`Saved “${created.title}”`);
  };

  if (naming) {
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
            if (e.key === 'Escape') setNaming(false);
          }}
          onBlur={() => setNaming(false)}
          data-testid="save-template-name"
        />
      </span>
    );
  }
  if (saved) return <span className="muted" data-testid="save-template-done">{saved}</span>;
  return (
    <button
      className="ghost small link"
      disabled={!props.body.trim()}
      title="Keep this text as a template. Mark blanks with {{name}} first."
      onClick={() => setNaming(true)}
      data-testid="save-template"
    >
      Save as template
    </button>
  );
}

/** The open draft: its text, its board, Ready and Delete. */
function DraftEditor(props: {
  book: DraftBook;
  shelf: TemplateShelf;
  draft: Draft;
  listBoards: () => Promise<BoardEntry[]>;
  focusRequest: number;
  onSend: () => void;
  onOpenBoard: (board: string) => void;
}) {
  const { book, draft } = props;
  const ref = useRef<HTMLTextAreaElement>(null);
  const [boards, setBoards] = useState<string[]>([]);

  useEffect(() => {
    void props.listBoards().then((list) => setBoards(list.map((b) => b.name)));
  }, [props.listBoards]);

  useEffect(() => {
    ref.current?.focus();
  }, [props.focusRequest]);

  const ready = draft.status === 'ready';
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || !e.metaKey) return;
    e.preventDefault();
    if (e.shiftKey) book.setReady(draft.id, !ready);
    else props.onSend();
  };

  const boardOptions = draft.board && !boards.includes(draft.board) ? [draft.board, ...boards] : boards;

  return (
    <section className="editor">
      <SlotArea
        areaRef={ref}
        testId="draft-body"
        label="Draft"
        placeholder={'Write a prompt or jot a note. Type / for a template.\n\n⌘↩ sends it. ⌘⇧↩ marks it Ready.'}
        value={draft.body}
        onChange={(body) => book.edit(draft.id, body)}
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
        <span className="spacer" />
        {(book.saveError || props.shelf.saveError) && (
          <span className="error" title={book.saveError ?? props.shelf.saveError} data-testid="save-error">
            Not saved yet. Retrying.
          </span>
        )}
        <SaveAsTemplate shelf={props.shelf} body={draft.body} />
        <DeleteButton what="draft" testId="draft-delete" onDelete={() => book.remove(draft.id)} />
        <button
          className="ghost"
          aria-pressed={ready}
          title={ready ? 'Back to notes (⌘⇧↩)' : 'Queue it for sending (⌘⇧↩)'}
          onClick={() => book.setReady(draft.id, !ready)}
          data-testid="draft-ready"
        >
          {ready && <CheckIcon />}
          Ready
        </button>
      </footer>
    </section>
  );
}
