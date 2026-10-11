import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { draftTitle } from '../shared/drafts';
import type { DraftBook } from './drafts';
import { CloseIcon, DraftIcon } from './Icons';
import { useDrafts, useEscape } from './WriteView';

/**
 * Sketch mode's link to Write mode. With a draft linked to the board, a chip
 * names it and Send leads with its text. Without one, a menu pulls a draft in.
 */
export function PullIn(props: { book: DraftBook; board: string; onOpen: (id: string) => void }) {
  const book = useDrafts(props.book);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const linked = book.linkedTo(props.board);
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', onDown, { capture: true });
    return () => window.removeEventListener('pointerdown', onDown, { capture: true });
  }, [open]);

  if (linked) {
    return (
      <div className="cluster pulled" data-testid="pulled-draft">
        <button className="ghost chip" title="Send leads with this draft. Open it in Write mode." onClick={() => props.onOpen(linked.id)}>
          <DraftIcon />
          <span>{draftTitle(linked.body, 32) || 'Empty note'}</span>
        </button>
        <button
          className="ghost icon-button small"
          title="Unlink the draft. It stays in Write mode."
          aria-label="Unlink the draft"
          onClick={() => book.link(linked.id, undefined)}
          data-testid="pulled-draft-unlink"
        >
          <CloseIcon />
        </button>
      </div>
    );
  }

  const drafts = book.drafts.filter((d) => d.body.trim());
  return (
    <div className="cluster anchor" ref={ref}>
      <button
        className="ghost icon-button"
        title="Pull in a draft"
        aria-label="Pull in a draft"
        aria-haspopup="dialog"
        aria-pressed={open}
        onClick={() => setOpen((o) => !o)}
        data-testid="pull-in"
      >
        <DraftIcon />
      </button>
      {open && (
        <PullInMenu onClose={close}>
          <h3>Send this sketch with a draft</h3>
          {drafts.length === 0 ? (
            <p className="muted">No drafts yet. Write one in Write mode (⌘2).</p>
          ) : (
            <ul>
              {drafts.map((d) => (
                <li key={d.id}>
                  <button
                    className="ghost"
                    onClick={() => {
                      book.link(d.id, props.board);
                      setOpen(false);
                    }}
                    data-testid="pull-in-item"
                  >
                    <span>{draftTitle(d.body)}</span>
                    <span className="muted">{d.status === 'ready' ? 'Ready' : d.board ? `on ${d.board}` : ''}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </PullInMenu>
      )}
    </div>
  );
}

function PullInMenu(props: { onClose: () => void; children: ReactNode }) {
  useEscape(props.onClose);
  return (
    <div className="popover-panel pull-in" role="dialog" aria-label="Pull in a draft" data-escape-owner data-testid="pull-in-menu">
      {props.children}
    </div>
  );
}
