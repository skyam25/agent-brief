import { useEffect, useState, type MouseEvent } from 'react';
import type { FeedbackFileSummary, OutputKind, OutputRecord } from '../protocol';
import { isUrlRef, outputLabel, outputTouchedAt } from '../shared/outputs';
import { isReviewable } from '../shared/review';
import { ContextMenu, type MenuPoint } from './ContextMenu';
import { ago, SectionHeader } from './DraftList';
import { CloseIcon, LinkIcon } from './Icons';
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

/** A file ref as a plain project path, so `./docs/a.md` and `docs/a.md` meet. */
export function canonicalRef(ref: string): string {
  const parts: string[] = [];
  for (const part of ref.split('/')) {
    if (part === '..') parts.pop();
    else if (part && part !== '.') parts.push(part);
  }
  return parts.join('/');
}

const EXT_KINDS: Record<string, OutputKind> = { md: 'markdown', markdown: 'markdown', mdx: 'markdown', html: 'html', htm: 'html', pdf: 'pdf', docx: 'docx', pptx: 'pptx', xlsx: 'xlsx' };

/** A row for a project file that carries feedback but is not among the session's outputs. */
const feedbackRecord = (f: FeedbackFileSummary): OutputRecord => ({ ref: f.output, kind: EXT_KINDS[f.output.split('.').at(-1)?.toLowerCase() ?? ''] ?? 'other', tier: 'detected' });

/**
 * The session's outputs: declared ones with their status, then the project's other
 * files with feedback, then the files Claude only touched, folded under a toggle.
 * Renders nothing when there are none.
 */
export function OutputsList(props: {
  store: OutputsStore;
  sessionId: string;
  /** The output open beside the list, marked as current. */
  selectedRef?: string;
  onOpen: (ref: string) => void;
  onDismiss: (ref: string) => void;
  /** Feedback files by project path. An HTML output shows its feedback in the review pane instead. */
  feedback?: Map<string, FeedbackFileSummary>;
  onFeedback?: (ref: string) => void;
  onCopyReference: (ref: string, title: string) => void;
}) {
  const { store, sessionId } = props;
  useStore(store);
  const [touchedOpen, setTouchedOpen] = useState<Record<string, boolean>>({});
  const [menu, setMenu] = useState<MenuPoint & { ref: string; title: string; feedbackOnly: boolean }>();

  // A failed read keeps the last copy.
  useEffect(() => {
    void store.load(sessionId).catch(() => undefined);
  }, [store, sessionId]);

  const info = store.info(sessionId);
  const all = info?.outputs ?? [];
  // Feedback lives with the file, so another session's items show here too.
  const listed = new Set([...all.map((r) => r.ref), ...(info?.hiddenRefs ?? [])].map(canonicalRef));
  const others = [...(props.feedback?.values() ?? [])].filter((f) => f.outputExists && !listed.has(f.output)).map(feedbackRecord);
  if (all.length === 0 && others.length === 0) return null;
  const declared = all.filter((r) => r.tier === 'declared');
  const touched = all.filter((r) => r.tier === 'detected');
  const open = !!touchedOpen[sessionId];
  const row = (r: OutputRecord, index: number, feedbackOnly = false) => {
    const summary = isUrlRef(r.ref) ? undefined : props.feedback?.get(canonicalRef(r.ref));
    return (
      <OutputRow
        key={r.ref}
        record={r}
        index={index}
        selected={r.ref === props.selectedRef}
        onOpen={() => props.onOpen(r.ref)}
        onDismiss={feedbackOnly ? undefined : () => props.onDismiss(r.ref)}
        feedbackOnly={feedbackOnly ? summary : undefined}
        feedback={summary}
        onFeedback={props.onFeedback && takesFeedback(r.ref) ? () => props.onFeedback!(canonicalRef(r.ref)) : undefined}
        onMenu={(e) => {
          e.preventDefault();
          setMenu({ ref: r.ref, title: outputLabel(r), x: e.clientX, y: e.clientY, feedbackOnly });
        }}
      />
    );
  };
  const listedRow = (r: OutputRecord) => row(r, all.indexOf(r));

  return (
    <section className="outputs" data-testid="outputs">
      <SectionHeader title="Outputs" count={all.length + others.length} />
      {declared.length > 0 && <ul>{declared.map(listedRow)}</ul>}
      {others.length > 0 && <ul data-testid="outputs-feedback">{others.map((r, i) => row(r, all.length + i, true))}</ul>}
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
          {open && <ul>{touched.map(listedRow)}</ul>}
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
                props.onFeedback!(canonicalRef(menu.ref));
              }}
              data-testid="output-menu-feedback"
            >
              Feedback
            </button>
          )}
          <button
            className="ghost"
            role="menuitem"
            onClick={() => {
              setMenu(undefined);
              props.onCopyReference(menu.ref, menu.title);
            }}
            data-testid="output-menu-copy-reference"
          >
            <LinkIcon /> Copy reference
          </button>
          {!menu.feedbackOnly && (
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
          )}
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
  /** The output's feedback file. A page shows its items in the review pane, a file in the Feedback view. */
  feedback?: FeedbackFileSummary;
  /** Set for a file listed only for its feedback, which the row names in place of a status. */
  feedbackOnly?: FeedbackFileSummary;
  onOpen: () => void;
  /** Absent for a row the session's outputs do not hold. */
  onDismiss?: () => void;
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
            {/* A row with a Feedback button carries its count there. */}
            {props.feedbackOnly ? (
              !props.onFeedback && (
                <span className="origin" data-testid={`output-feedback-only-${index}`}>
                  Feedback · {props.feedbackOnly.open} open
                </span>
              )
            ) : declared ? (
              <>
                <span className={`status-chip ${r.status ?? 'drafting'}`} data-testid={`output-status-${index}`}>
                  {r.status === 'ready' ? 'Ready' : 'Drafting'}
                </span>
                {props.feedback && !props.onFeedback && props.feedback.items > 0 && (
                  <span className="origin" data-testid={`output-feedback-count-${index}`}>
                    Feedback · {props.feedback.open} open
                  </span>
                )}
              </>
            ) : (
              r.origin && <span className="origin">{r.origin}</span>
            )}
          </span>
        </span>
      </button>
      {props.onDismiss && (
        <button
          className="ghost icon-button small output-dismiss"
          aria-label="Hide"
          title="Hide until Claude writes it again"
          onClick={props.onDismiss}
          data-testid={`output-dismiss-${index}`}
        >
          <CloseIcon />
        </button>
      )}
      {props.feedback && props.onFeedback && (
        <button className="ghost output-feedback" title="Open its feedback items" onClick={props.onFeedback} data-testid={`output-feedback-${index}`}>
          Feedback{props.feedback.open ? ` · ${props.feedback.open} open` : ''}
        </button>
      )}
    </li>
  );
}
