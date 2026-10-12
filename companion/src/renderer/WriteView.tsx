import { useCallback, useEffect, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from 'react';
import type { OutputKind, OutputRecord } from '../protocol';
import { draftPreview, draftTitle } from '../shared/drafts';
import type { BoardEntry, Draft, SessionBriefEntry, Template } from '../shared/ipc';
import { outputLabel, outputTouchedAt } from '../shared/outputs';
import { plainSlots } from '../shared/slots';
import { onTab, type DraftBook } from './drafts';
import { CheckIcon, ChevronIcon, CloseIcon, GripIcon, LinkIcon, MoreIcon, PlusIcon, TrashIcon } from './Icons';
import { focusFirstSlot, RichEditor, type RichEditorHandle } from './editor/RichEditor';
import { newPictureId } from './editor/pictures';
import { SlotArea } from './SlotArea';
import { useEscape, usePointerOutside, useStore } from './hooks';
import type { OutputsStore } from './outputs';
import { ReviewView, type ReviewDraft, type ReviewHost } from './ReviewView';
import type { ReviewVoice } from './review-voice';
import type { TemplateShelf } from './templates';
import { baseName, commentCount } from '../shared/review';

/** `5m`, `3h`, or a date, for the list. */
export function ago(ms: number, now = Date.now()): string {
  const s = Math.max(0, (now - ms) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

const matches = (d: Draft, query: string) => !query || d.body.toLowerCase().includes(query.toLowerCase());

/** A session tab, as the filing menu names it. */
export type FilingTab = Pick<SessionBriefEntry, 'sessionId' | 'title'>;

/** The session tab a draft is filed under, or undefined when it shows on the Notes tab. */
const filedTab = (d: Draft, tabs: FilingTab[]) => tabs.find((t) => t.sessionId === d.sessionId);

/** Write mode: Ready drafts, notes and templates on the left; the open one on the right. */
export function WriteView(props: {
  book: DraftBook;
  shelf: TemplateShelf;
  listBoards: () => Promise<BoardEntry[]>;
  /** Bumped to put the cursor in the editor. */
  focusRequest: number;
  /** The session tab on show. Undefined on the Notes tab. */
  sessionId?: string;
  /** The session tabs a draft can be filed under. */
  tabs: FilingTab[];
  onSend: () => void;
  onOpenBoard: (board: string) => void;
  /** A draft moved to another tab; `where` names it. */
  onFiled?: (where: string) => void;
  /** The filing menu opened. A toast would cover it, so App clears one. */
  onFilingMenu?: () => void;
  outputs: OutputsStore;
  onOpenOutput: (sessionId: string, ref: string) => void;
  /** Hides an output until Claude writes it again. */
  onDismissOutput: (sessionId: string, ref: string) => void;
  /** What the review pane needs, for a draft that reviews an HTML output. */
  review: { host: ReviewHost; voice: ReviewVoice; onError: (message: string) => void };
}) {
  const book = useStore(props.book);
  const shelf = useStore(props.shelf);
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
    book.create(t.body, undefined, props.sessionId);
    focusFirstSlot('draft-body');
  };
  const newTemplate = async () => {
    setNewMenu(false);
    const created = await shelf.create('New template', '');
    openTemplate(created.id);
  };
  const tabIds = props.tabs.map((t) => t.sessionId);
  const here = (d: Draft) => onTab(d, props.sessionId, tabIds);
  const ready = book.ready.filter((d) => here(d) && matches(d, query));
  const notes = book.drafts.filter(
    (d) => d.status === 'note' && here(d) && matches(d, query) && (d.body.trim() || d.board || d.id === selected?.id),
  );

  /** Moves a Ready draft to `index` among the ones shown, counted without it, keeping other tabs' order. */
  const moveShown = (id: string, index: number) => {
    const rest = ready.filter((d) => d.id !== id);
    if (index < 0 || rest.length === 0) return;
    const queue = book.ready.filter((d) => d.id !== id);
    const at = index < rest.length ? queue.indexOf(rest[index]!) : queue.indexOf(rest[rest.length - 1]!) + 1;
    book.move(id, at);
  };

  /** Files a draft. One that leaves this tab closes, and the next draft here opens. */
  const fileUnder = (d: Draft, sessionId: string | undefined) => {
    if (d.sessionId === sessionId) return;
    book.file(d.id, sessionId);
    const moved = book.get(d.id);
    if (!moved || here(moved)) return;
    book.select(book.firstOnTab(props.sessionId, tabIds)?.id);
    props.onFiled?.(sessionId ? (filedTab(moved, props.tabs)?.title ?? 'that session') : 'Notes');
  };

  // A review takes the whole view, for the page's sake. The list stays mounted, so it comes back as it was.
  const reviewing = !!selected?.review && !template;

  return (
    <div className={reviewing ? 'write reviewing' : 'write'} data-testid="write">
      <nav className="draft-list" aria-label="Drafts" hidden={reviewing}>
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
                book.create('', undefined, props.sessionId);
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
          {props.sessionId && (
            <OutputsList
              store={props.outputs}
              sessionId={props.sessionId}
              onOpen={(ref) => props.onOpenOutput(props.sessionId!, ref)}
              onDismiss={(ref) => props.onDismissOutput(props.sessionId!, ref)}
            />
          )}
          <ReadyQueue drafts={ready} tabs={props.tabs} selectedId={selected?.id} reorder={!query} onOpen={openDraft} onMove={moveShown} />
          <section>
            <SectionHeader title="Notes" count={notes.length} />
            {notes.length === 0 && <p className="muted empty">{query ? 'No notes match.' : 'Notes you jot down wait here until you send them.'}</p>}
            <ul>
              {notes.map((d) => (
                <DraftRow key={d.id} draft={d} tabs={props.tabs} selected={d.id === selected?.id} onSelect={() => openDraft(d.id)} />
              ))}
            </ul>
          </section>
          <section>
            <SectionHeader
              title="Templates"
              count={shelf.templates.length}
              open={templatesOpen}
              onToggle={() => setTemplatesOpen((o) => !o)}
              testId="templates-toggle"
            />
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
                        <span className="muted">{draftTitle(plainSlots(t.body)) || 'Empty'}</span>
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
      {reviewing ? (
        <ReviewView
          key={selected.id}
          host={props.review.host}
          book={props.book}
          draft={selected as ReviewDraft}
          voice={props.review.voice}
          onClose={() => book.select(undefined)}
          onSend={props.onSend}
          onError={props.review.onError}
        />
      ) : template ? (
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
          tabs={props.tabs}
          onFile={(sessionId) => fileUnder(selected, sessionId)}
          onFilingMenu={props.onFilingMenu}
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

const KIND_LABELS: Record<OutputKind, string> = {
  markdown: 'Markdown',
  html: 'HTML',
  pdf: 'PDF',
  docx: 'Word',
  pptx: 'Slides',
  xlsx: 'Sheet',
  artifact: 'Link',
  other: 'File',
};

/** The last part of a path, or the whole ref for a URL. */
const fileName = (ref: string) => ref.split('/').filter(Boolean).at(-1) ?? ref;

/**
 * The session's outputs: declared ones with their status, then the files Claude
 * only touched, folded under a toggle. Renders nothing when there are none.
 */
function OutputsList(props: { store: OutputsStore; sessionId: string; onOpen: (ref: string) => void; onDismiss: (ref: string) => void }) {
  const { store, sessionId } = props;
  useStore(store);
  const [touchedOpen, setTouchedOpen] = useState<Record<string, boolean>>({});

  // A failed read keeps the last copy.
  useEffect(() => {
    void store.load(sessionId).catch(() => undefined);
  }, [store, sessionId]);

  const all = store.info(sessionId)?.outputs ?? [];
  if (all.length === 0) return null;
  const declared = all.filter((r) => r.tier === 'declared');
  const touched = all.filter((r) => r.tier === 'detected');
  const open = !!touchedOpen[sessionId];
  const row = (r: OutputRecord) => (
    <OutputRow key={r.ref} record={r} index={all.indexOf(r)} onOpen={() => props.onOpen(r.ref)} onDismiss={() => props.onDismiss(r.ref)} />
  );

  return (
    <section className="outputs" data-testid="outputs">
      <SectionHeader title="Outputs" count={all.length} />
      {declared.length > 0 && <ul>{declared.map(row)}</ul>}
      {touched.length > 0 && (
        <>
          <button
            className="ghost touched-toggle"
            aria-expanded={open}
            onClick={() => setTouchedOpen((o) => ({ ...o, [sessionId]: !open }))}
            data-testid="outputs-touched-toggle"
          >
            <span className="caret" aria-hidden="true">
              {open ? '▾' : '▸'}
            </span>
            Touched ({touched.length})
          </button>
          {open && <ul>{touched.map(row)}</ul>}
        </>
      )}
    </section>
  );
}

function OutputRow(props: { record: OutputRecord; index: number; onOpen: () => void; onDismiss: () => void }) {
  const { record: r, index } = props;
  const label = outputLabel(r);
  const declared = r.tier === 'declared';
  const showRef = !!r.title && r.title !== fileName(r.ref);
  const at = outputTouchedAt(r);
  return (
    <li className="output-item">
      <button className="ghost draft-row output-row" onClick={props.onOpen} title={r.ref} data-testid={`output-row-${index}`} data-ref={r.ref}>
        <span className="lines">
          <span className="title-line">
            <span className="title">{label}</span>
            {at > 0 && <span className="muted when">{ago(at)}</span>}
          </span>
          {showRef && <span className="muted output-ref">{r.ref}</span>}
          <span className="muted preview">
            <span className="kind-tag">{KIND_LABELS[r.kind]}</span>
            {declared ? (
              <span className={`status-chip ${r.status ?? 'drafting'}`} data-testid={`output-status-${index}`}>
                {r.status === 'ready' ? 'Ready' : 'Drafting'}
              </span>
            ) : (
              r.origin && <span className="origin">{r.origin}</span>
            )}
          </span>
        </span>
      </button>
      <button
        className="ghost icon-button small output-dismiss"
        aria-label="Hide"
        title="Hide until Claude writes it again"
        onClick={props.onDismiss}
        data-testid={`output-dismiss-${index}`}
      >
        <CloseIcon />
      </button>
    </li>
  );
}

/** Ready drafts in send order. Drag the grip, or press ⌥↑ and ⌥↓, to reorder. */
function ReadyQueue(props: {
  drafts: Draft[];
  tabs: FilingTab[];
  selectedId?: string;
  reorder: boolean;
  onOpen: (id: string) => void;
  /** Moves a draft to `index` among these drafts, counted without it. */
  onMove: (id: string, index: number) => void;
}) {
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
    props.onMove(d.id, e.key === 'ArrowUp' ? i - 1 : i + 1);
  };

  return (
    <section>
      <SectionHeader title="Ready" count={props.drafts.length} />
      {props.drafts.length === 0 && <p className="muted empty">Mark a draft Ready (⌘⇧↩) to queue it for sending.</p>}
      <ul data-testid="ready-list" onDragLeave={() => setDropAt(undefined)}>
        {props.drafts.map((d, i) => (
          <DraftRow
            key={d.id}
            draft={d}
            tabs={props.tabs}
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
                      if (dragging) props.onMove(dragging, indexAt(e, i));
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
  tabs: FilingTab[];
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
  const body = plainSlots(d.body);
  const title = d.review ? `Review of ${baseName(d.review.path)}` : draftTitle(body) || 'Empty note';
  const preview = d.review ? commentCount(d.review.comments.length) : draftPreview(body);
  const filed = filedTab(d, props.tabs);
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
          <span className="title-line">
            <span className={d.body.trim() || d.review ? 'title' : 'title muted'}>{title}</span>
            <span className="muted when">{ago(d.updatedAt)}</span>
          </span>
          <span className="muted preview">
            <span className={filed ? 'filing-tag filed' : 'filing-tag'} data-testid="draft-row-filing">
              {filed?.title ?? 'Unfiled'}
            </span>
            {d.board && (
              <span className="board-tag" title={`Goes with the board ${d.board}`}>
                <LinkIcon /> {d.board}
              </span>
            )}
            {preview}
          </span>
        </span>
      </button>
    </li>
  );
}

/** A list section's name and count. With `onToggle`, a click folds the section. */
function SectionHeader(props: { title: string; count: number; open?: boolean; onToggle?: () => void; testId?: string }) {
  const label = (
    <>
      {props.onToggle && (
        <span className="caret" aria-hidden="true">
          {props.open ? '▾' : '▸'}
        </span>
      )}
      {props.title}
      {props.count > 0 && <span className="count">{props.count}</span>}
    </>
  );
  return (
    <h3 className="section-head">
      {props.onToggle ? (
        <button className="ghost section-toggle" aria-expanded={props.open} onClick={props.onToggle} data-testid={props.testId}>
          {label}
        </button>
      ) : (
        label
      )}
    </h3>
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
  usePointerOutside(ref, props.onClose, { parent: true });
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

/** A button whose menu opens upward, for the editor's footer. `trigger` draws the button. */
function FooterMenu(props: {
  trigger: (open: boolean, toggle: () => void) => ReactNode;
  className?: string;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  usePointerOutside(ref, close, { active: open });
  return (
    <div className="anchor" ref={ref}>
      {props.trigger(open, () => setOpen((o) => !o))}
      {open && (
        <MoreMenuPanel onClose={close} className={props.className}>
          {props.children(close)}
        </MoreMenuPanel>
      )}
    </div>
  );
}

/** A ⋯ button whose menu opens upward. */
function MoreMenu(props: { label: string; testId: string; children: (close: () => void) => ReactNode }) {
  return (
    <FooterMenu
      trigger={(open, toggle) => (
        <button
          className="ghost icon-button"
          aria-label={props.label}
          title={props.label}
          aria-haspopup="menu"
          aria-pressed={open}
          onClick={toggle}
          data-testid={props.testId}
        >
          <MoreIcon />
        </button>
      )}
    >
      {props.children}
    </FooterMenu>
  );
}

function MoreMenuPanel(props: { onClose: () => void; children: ReactNode; className?: string }) {
  useEscape(props.onClose);
  return (
    <div className={`popover-panel more-menu up${props.className ? ` ${props.className}` : ''}`} role="menu" data-escape-owner>
      {props.children}
    </div>
  );
}

/** A menu item that asks once more before it deletes, then reverts after a few seconds. */
function DeleteItem(props: { what: string; onDelete: () => void; testId: string }) {
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    if (!confirm) return;
    const timer = setTimeout(() => setConfirm(false), 3000);
    return () => clearTimeout(timer);
  }, [confirm]);
  return (
    <button className="ghost danger" role="menuitem" onClick={() => (confirm ? props.onDelete() : setConfirm(true))} data-testid={props.testId}>
      <TrashIcon />
      {confirm ? 'Click again to delete' : `Delete ${props.what}`}
    </button>
  );
}

/** The session a draft is filed under, as a chip whose menu files it elsewhere. */
function FilingMenu(props: { draft: Draft; tabs: FilingTab[]; onFile: (sessionId: string | undefined) => void; onOpen?: () => void }) {
  const filed = filedTab(props.draft, props.tabs);
  const item = (sessionId: string | undefined, label: string, close: () => void) => (
    <button
      key={sessionId ?? ''}
      className="ghost"
      role="menuitemradio"
      aria-checked={filed?.sessionId === sessionId}
      onClick={() => {
        close();
        props.onFile(sessionId);
      }}
      data-testid="file-under"
      data-session={sessionId ?? ''}
    >
      <span className="label-text">{label}</span>
      {filed?.sessionId === sessionId && <CheckIcon />}
    </button>
  );
  return (
    <FooterMenu
      className="filing-menu"
      trigger={(open, toggle) => (
        <button
          className={filed ? 'chip filing filed' : 'chip filing'}
          aria-haspopup="menu"
          aria-pressed={open}
          title={filed ? `Filed under ${filed.title}. Click to file it elsewhere.` : 'On the Notes tab. Click to file it under a session.'}
          onClick={() => {
            if (!open) props.onOpen?.();
            toggle();
          }}
          data-testid="draft-filing"
        >
          <span className="label-text">{filed?.title ?? 'Unfiled'}</span>
          <ChevronIcon />
        </button>
      )}
    >
      {(close) => (
        <>
          <h3>File under</h3>
          {props.tabs.map((t) => item(t.sessionId, t.title, close))}
          {item(undefined, 'Unfiled', close)}
        </>
      )}
    </FooterMenu>
  );
}

const NO_PICTURES: Record<string, string> = {};

/** The open draft: its text, its board, where it is filed, Ready and Delete. */
function DraftEditor(props: {
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
}) {
  const { book, draft } = props;
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
