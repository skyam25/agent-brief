import { useEffect, useRef, useState } from 'react';
import { draftTitle } from '../shared/drafts';
import type { BoardEntry, Draft, Template } from '../shared/ipc';
import { plainSlots } from '../shared/slots';
import { DraftEditor } from './DraftEditor';
import { DraftRow, ReadyQueue, SectionHeader } from './DraftList';
import { onTab, type DraftBook } from './drafts';
import { focusFirstSlot } from './editor/RichEditor';
import { filedTab, type FilingTab } from './FilingMenu';
import { ChevronIcon, PlusIcon } from './Icons';
import { useEscape, usePointerOutside, useStore } from './hooks';
import { OutputsList } from './OutputsList';
import type { OutputsStore } from './outputs';
import { ReviewView, type ReviewDraft, type ReviewHost } from './ReviewView';
import type { ReviewVoice } from './review-voice';
import { TemplateEditor } from './TemplateEditor';
import type { TemplateShelf } from './templates';

export { ago } from './DraftList';
export type { FilingTab } from './FilingMenu';

const matches = (d: Draft, query: string) => !query || d.body.toLowerCase().includes(query.toLowerCase());

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
