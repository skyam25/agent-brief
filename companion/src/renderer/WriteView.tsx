import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import type { OutlineKind } from '../protocol';
import { draftTitle, inWrite } from '../shared/drafts';
import type { BoardEntry, CompanionApi, Draft, OutlineCreate, Template } from '../shared/ipc';
import { plainSlots } from '../shared/slots';
import { ContextMenu, type MenuPoint } from './ContextMenu';
import { DraftEditor } from './DraftEditor';
import { DraftRow, ReadyQueue, SectionHeader } from './DraftList';
import type { SendFeedback } from './FeedbackPanel';
import { onTab, type DraftBook } from './drafts';
import { focusFirstSlot, openFind, stepFind } from './editor/RichEditor';
import { DeleteItem } from './FooterMenu';
import { filedTab, type FilingTab } from './FilingMenu';
import { CheckIcon, ChevronIcon, LinkIcon, PlusIcon } from './Icons';
import { useEscape, usePointerOutside, useStore } from './hooks';
import { kindFor } from './outline-edit';
import { cleanError } from './ipc-error';
import { OutlineEditor, type OutlineHost } from './OutlineEditor';
import type { ReviewVoice } from './review-voice';
import { TemplateEditor } from './TemplateEditor';
import type { TemplateShelf } from './templates';

export { ago } from './DraftList';
export type { FilingTab } from './FilingMenu';

/** The row a right-click opened a menu on. */
type RowMenu = MenuPoint & { kind: 'draft' | 'template'; id: string };

const matches = (d: Draft, query: string) => !query || `${d.title ?? ''}\n${d.body}`.toLowerCase().includes(query.toLowerCase());

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
  /** The File under list opened. A toast would cover it, so App clears one. */
  onFilingMenu?: () => void;
  /** Puts a note on the clipboard as rich text and Markdown. False when that failed, which the panel has reported. */
  onCopy: (clip: { html: string; text: string }) => Promise<boolean>;
  /** Puts a line on the clipboard that a new session can pick the note up from. */
  onCopyReference: (d: Draft) => void;
  /** The target chip and Send, shown at the right end of the open draft's footer. */
  sendBar?: ReactNode;
  /** The mic, which talks to the open note's comments. */
  voice: ReviewVoice;
  /** The mic is on. */
  talking: boolean;
  /** Opens a draft filed under another tab, on its tab. */
  onOpenElsewhere: (d: Draft) => Promise<void>;
  /** Reads and writes outline files, for outline drafts and New → Outline. */
  outlineHost: OutlineHost & Pick<CompanionApi, 'createOutline'>;
  /** Hands Claude a fixed prompt for a session, as Review's Feedback does. */
  onSendText: SendFeedback;
  onError: (message: string) => void;
}) {
  const book = useStore(props.book);
  const shelf = useStore(props.shelf);
  const [query, setQuery] = useState('');
  const [templateId, setTemplateId] = useState<string>();
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [newMenu, setNewMenu] = useState(false);
  const [rowMenu, setRowMenu] = useState<RowMenu>();
  // Reviews open in Review mode.
  const selected = book.selected?.review ? undefined : book.selected;
  const template = shelf.get(templateId);

  // Opening a draft from anywhere, such as the capture shortcut, closes the template.
  useEffect(() => {
    if (book.selectedId) setTemplateId(undefined);
  }, [book.selectedId]);

  // ⌘F finds in the open note wherever focus sits in Write. ⌘G steps through the matches.
  const noteOpen = !!selected && !selected.outline && !template;
  useEffect(() => {
    if (!noteOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.metaKey || e.ctrlKey || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === 'f' && !e.shiftKey) {
        e.preventDefault();
        openFind('draft-body');
      } else if (key === 'g' && stepFind('draft-body', e.shiftKey ? -1 : 1)) {
        e.preventDefault();
      }
    };
    document.addEventListener('keydown', onKeyDown, { capture: true });
    return () => document.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [noteOpen]);

  /** Opens a draft. While the list is filtered, the note opens with its matches found. */
  const openDraft = (id: string) => {
    setTemplateId(undefined);
    book.select(id);
    if (query.trim()) openFind('draft-body', query.trim());
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
  /** Makes the outline file and its draft in the session on show, then opens it. */
  const createOutline = async (create: OutlineCreate) => {
    if (!props.sessionId) return;
    try {
      const { draftId } = await props.outlineHost.createOutline(props.sessionId, create);
      setNewMenu(false);
      setTemplateId(undefined);
      if (!book.get(draftId)) await book.load();
      book.select(draftId);
    } catch (err) {
      props.onError(`Could not create the outline: ${cleanError(err)}`);
    }
  };
  const newTemplate = async () => {
    setNewMenu(false);
    const created = await shelf.create('New template', '');
    openTemplate(created.id);
  };
  const openRowMenu = (kind: RowMenu['kind'], id: string, e: MouseEvent) => {
    e.preventDefault();
    setRowMenu({ kind, id, x: e.clientX, y: e.clientY });
  };
  const deleteTemplate = (id: string) => {
    shelf.remove(id);
    if (templateId === id) setTemplateId(undefined);
  };
  const tabIds = props.tabs.map((t) => t.sessionId);
  const here = (d: Draft) => onTab(d, props.sessionId, tabIds);
  const ready = book.ready.filter((d) => here(d) && matches(d, query));
  const notes = book.drafts.filter(
    (d) => d.status === 'note' && inWrite(d) && here(d) && matches(d, query) && (d.body.trim() || d.board || d.outline || d.id === selected?.id),
  );
  /** While searching, matches filed under other tabs, so a note never hides behind the wrong tab. */
  const elsewhere = query.trim() ? book.drafts.filter((d) => inWrite(d) && !here(d) && (d.body.trim() || d.outline) && matches(d, query)) : [];
  const placeOf = (d: Draft) => filedTab(d, props.tabs)?.title ?? 'Unfiled';
  const openElsewhere = async (d: Draft) => {
    setTemplateId(undefined);
    await props.onOpenElsewhere(d);
    openFind('draft-body', query.trim());
  };

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
    props.onFiled?.(sessionId ? (filedTab(moved, props.tabs)?.title ?? 'that session') : 'Unfiled');
  };

  return (
    <div className="write" data-testid="write">
      <nav className="draft-list" aria-label="Drafts">
        <div className="list-head">
          <input
            type="search"
            placeholder="Search notes"
            aria-label="Search notes"
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
              <NewMenu
                templates={shelf.templates}
                sessionId={props.sessionId}
                onUse={useTemplate}
                onNewTemplate={() => void newTemplate()}
                onCreateOutline={createOutline}
                onClose={() => setNewMenu(false)}
              />
            )}
          </div>
        </div>
        <div className="sections">
          <ReadyQueue
            drafts={ready} selectedId={selected?.id} reorder={!query}
            onOpen={openDraft}
            onMove={moveShown}
            onMenu={(id, e) => openRowMenu('draft', id, e)}
          />
          <section>
            <SectionHeader title="Notes" count={notes.length} />
            {notes.length === 0 && <p className="muted empty">{query ? 'No notes match.' : 'Notes you jot down wait here until you send them.'}</p>}
            <ul>
              {notes.map((d) => (
                <DraftRow
                  key={d.id}
                  draft={d}
                  selected={d.id === selected?.id}
                  onSelect={() => openDraft(d.id)}
                  onMenu={(e) => openRowMenu('draft', d.id, e)}
                />
              ))}
            </ul>
          </section>
          {elsewhere.length > 0 && (
            <section data-testid="draft-elsewhere">
              <SectionHeader title="In other sessions" count={elsewhere.length} />
              <ul>
                {elsewhere.map((d) => (
                  <DraftRow key={d.id} draft={d} selected={false} place={placeOf(d)} onSelect={() => void openElsewhere(d)} />
                ))}
              </ul>
            </section>
          )}
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
                      onContextMenu={(e) => openRowMenu('template', t.id, e)}
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
      {rowMenu && (
        <RowMenuPanel
          menu={rowMenu}
          book={props.book}
          shelf={props.shelf}
          onUse={useTemplate}
          onDeleteTemplate={deleteTemplate}
          onCopyReference={props.onCopyReference}
          onClose={() => setRowMenu(undefined)}
        />
      )}
      {template ? (
        <TemplateEditor
          key={template.id}
          shelf={shelf}
          template={template}
          onUse={() => useTemplate(template)}
          onDeleted={() => setTemplateId(undefined)}
        />
      ) : selected?.outline ? (
        <OutlineEditor
          key={selected.id}
          host={props.outlineHost}
          draft={selected}
          onSend={props.onSendText}
          onError={props.onError}
          onRetitle={(title) => book.retitle(selected.id, title)}
          onCopyReference={() => props.onCopyReference(selected)}
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
          onCopy={props.onCopy}
          onCopyReference={() => props.onCopyReference(selected)}
          sendBar={props.sendBar}
          voice={props.voice}
          talking={props.talking}
          outlineHost={props.outlineHost}
        />
      ) : (
        <div className="editor empty-editor">
          <p className="muted">Pick a draft, or start a note with ⌘N.</p>
        </div>
      )}
    </div>
  );
}

/** The right-click menu on a draft or template row. Delete asks once more. */
function RowMenuPanel(props: {
  menu: RowMenu;
  book: DraftBook;
  shelf: TemplateShelf;
  onUse: (t: Template) => void;
  onDeleteTemplate: (id: string) => void;
  onCopyReference: (d: Draft) => void;
  onClose: () => void;
}) {
  const { menu, book, shelf, onClose } = props;
  const run = (fn: () => void) => () => {
    fn();
    onClose();
  };

  if (menu.kind === 'template') {
    const t = shelf.get(menu.id);
    if (!t) return null;
    return (
      <ContextMenu x={menu.x} y={menu.y} label={`Template ${t.title}`} testId="row-menu" onClose={onClose}>
        <button className="ghost" role="menuitem" onClick={run(() => props.onUse(t))} data-testid="row-menu-use">
          <PlusIcon /> Use template
        </button>
        <hr />
        <DeleteItem what="template" testId="row-menu-delete" onDelete={run(() => props.onDeleteTemplate(t.id))} />
      </ContextMenu>
    );
  }

  const d = book.get(menu.id);
  if (!d) return null;
  const ready = d.status === 'ready';
  return (
    <ContextMenu x={menu.x} y={menu.y} label="Note" testId="row-menu" onClose={onClose}>
      <button className="ghost" role="menuitem" onClick={run(() => book.setReady(d.id, !ready))} data-testid="row-menu-ready">
        <CheckIcon /> {ready ? 'Back to notes' : 'Mark Ready'}
      </button>
      <button className="ghost" role="menuitem" onClick={run(() => props.onCopyReference(d))} data-testid="row-menu-copy">
        <LinkIcon /> Copy reference
      </button>
      <hr />
      <DeleteItem what="note" testId="row-menu-delete" onDelete={run(() => book.remove(d.id))} />
    </ContextMenu>
  );
}

/** Blank notes come from ⌘N; this menu starts an outline, or a note from a template. */
function NewMenu(props: {
  templates: Template[];
  sessionId?: string;
  onUse: (t: Template) => void;
  onNewTemplate: () => void;
  onCreateOutline: (create: OutlineCreate) => Promise<void>;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [outline, setOutline] = useState(false);
  usePointerOutside(ref, props.onClose, { parent: true });
  useEscape(props.onClose);
  if (outline) {
    return (
      <div className="popover-panel new-menu new-outline" ref={ref} role="dialog" aria-label="New outline" data-escape-owner data-testid="new-menu">
        <h3>New outline</h3>
        {props.sessionId ? (
          <OutlineForm onCreate={props.onCreateOutline} />
        ) : (
          <p className="muted" data-testid="outline-new-no-session">
            Pick a session first. An outline lives in a session's project, beside what it generates.
          </p>
        )}
      </div>
    );
  }
  return (
    <div className="popover-panel new-menu" ref={ref} role="menu" aria-label="New from a template" data-escape-owner data-testid="new-menu">
      <button className="ghost" role="menuitem" title="Shape the points, cites and open questions, then generate a document or page" onClick={() => setOutline(true)} data-testid="new-menu-outline">
        <PlusIcon /> Outline…
      </button>
      <hr />
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

/** Asks for an outline's title, an optional target and its kind. A target ending .html suggests Page. */
function OutlineForm(props: { onCreate: (create: OutlineCreate) => Promise<void> }) {
  const [title, setTitle] = useState('');
  const [target, setTarget] = useState('');
  const [picked, setPicked] = useState<OutlineKind>();
  const [busy, setBusy] = useState(false);
  const kind = picked ?? kindFor(target) ?? 'document';
  const create = async () => {
    if (!title.trim() || busy) return;
    setBusy(true);
    await props.onCreate({ title: title.trim(), kind, ...(target.trim() ? { target: target.trim() } : {}) });
    setBusy(false);
  };
  const onEnter = (e: { key: string; preventDefault: () => void }) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    void create();
  };
  return (
    <>
      <input autoFocus aria-label="Outline title" placeholder="Title, such as Onboarding memo" value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={onEnter} data-testid="outline-new-title" />
      <input aria-label="Target" placeholder="Target path (optional), such as docs/memo.md" value={target} onChange={(e) => setTarget(e.target.value)} onKeyDown={onEnter} data-testid="outline-new-target" />
      <span className="outline-kind" role="group" aria-label="Kind">
        {(['document', 'page'] as const).map((k) => (
          <button key={k} className={kind === k ? 'ghost on' : 'ghost'} aria-pressed={kind === k} onClick={() => setPicked(k)} data-testid={`outline-new-kind-${k}`}>
            {k === 'document' ? 'Document' : 'Page'}
          </button>
        ))}
      </span>
      <button className="primary" disabled={!title.trim() || busy} onClick={() => void create()} data-testid="outline-new-create">
        Create outline
      </button>
    </>
  );
}
