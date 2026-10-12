import { useEffect, useState } from 'react';
import type { OutputKind, OutputRecord } from '../protocol';
import { outputLabel, outputTouchedAt } from '../shared/outputs';
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
export function OutputsList(props: { store: OutputsStore; sessionId: string; onOpen: (ref: string) => void; onDismiss: (ref: string) => void }) {
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
