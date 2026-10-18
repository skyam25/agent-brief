import { useEffect, useState, type MouseEvent } from 'react';
import type { FeedbackFileSummary, OutputKind, OutputRecord } from '../protocol';
import { isUrlRef, outputLabel, outputTouchedAt } from '../shared/outputs';
import { isReviewable } from '../shared/review';
import { ContextMenu, type MenuPoint } from './ContextMenu';
import { ago, SectionHeader } from './DraftList';
import { CloseIcon } from './Icons';
import { useStore } from './hooks';
import type { OutputsStore } from './outputs';

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
export function OutputsList(props: {
  store: OutputsStore;
  sessionId: string;
  /** The output open beside the list, marked as current. */
  selectedRef?: string;
  onOpen: (ref: string) => void;
  onDismiss: (ref: string) => void;
  /** Feedback files by output. An HTML output shows its feedback in the review pane instead. */
  feedback?: Map<string, FeedbackFileSummary>;
  onFeedback?: (ref: string) => void;
}) {
  const { store, sessionId } = props;
  useStore(store);
  const [touchedOpen, setTouchedOpen] = useState<Record<string, boolean>>({});
  const [menu, setMenu] = useState<MenuPoint & { ref: string }>();

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
    <OutputRow
      key={r.ref}
      record={r}
      index={all.indexOf(r)}
      selected={r.ref === props.selectedRef}
      onOpen={() => props.onOpen(r.ref)}
      onDismiss={() => props.onDismiss(r.ref)}
      feedback={takesFeedback(r.ref) ? props.feedback?.get(r.ref) : undefined}
      onFeedback={props.onFeedback && takesFeedback(r.ref) ? () => props.onFeedback!(r.ref) : undefined}
      onMenu={(e) => {
        e.preventDefault();
        setMenu({ ref: r.ref, x: e.clientX, y: e.clientY });
      }}
    />
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
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} label="Output" testId="output-menu" onClose={() => setMenu(undefined)}>
          <button
            className="ghost"
            role="menuitem"
            onClick={() => {
              setMenu(undefined);
              props.onOpen(menu.ref);
            }}
            data-testid="output-menu-open"
          >
            Open
          </button>
          {props.onFeedback && takesFeedback(menu.ref) && (
            <button
              className="ghost"
              role="menuitem"
              onClick={() => {
                setMenu(undefined);
                props.onFeedback!(menu.ref);
              }}
              data-testid="output-menu-feedback"
            >
              Feedback
            </button>
          )}
          <button
            className="ghost"
            role="menuitem"
            title="Hide until Claude writes it again"
            onClick={() => {
              setMenu(undefined);
              props.onDismiss(menu.ref);
            }}
            data-testid="output-menu-hide"
          >
            <CloseIcon /> Hide from list
          </button>
        </ContextMenu>
      )}
    </section>
  );
}

/** A file output the Feedback view opens full width. */
const takesFeedback = (ref: string) => !isUrlRef(ref) && !isReviewable(ref);

function OutputRow(props: {
  record: OutputRecord;
  index: number;
  selected: boolean;
  feedback?: FeedbackFileSummary;
  onOpen: () => void;
  onDismiss: () => void;
  onFeedback?: () => void;
  onMenu: (e: MouseEvent) => void;
}) {
  const { record: r, index } = props;
  const label = outputLabel(r);
  const declared = r.tier === 'declared';
  const showRef = !!r.title && r.title !== fileName(r.ref);
  const at = outputTouchedAt(r);
  return (
    <li className="output-item">
      <button className="ghost draft-row output-row" aria-current={props.selected} onClick={props.onOpen} onContextMenu={props.onMenu} title={r.ref} data-testid={`output-row-${index}`} data-ref={r.ref}>
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
      {props.feedback && props.onFeedback && (
        <button className="ghost output-feedback" title="Open its feedback items" onClick={props.onFeedback} data-testid={`output-feedback-${index}`}>
          Feedback{props.feedback.open ? ` · ${props.feedback.open}` : ''}
        </button>
      )}
    </li>
  );
}
