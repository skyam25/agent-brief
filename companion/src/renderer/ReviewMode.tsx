/**
 * Review mode: what Claude hands back for the active session. The list holds its
 * outputs and the reviews in progress. The pane holds its items, or the open review.
 */

import { useEffect, useRef, useState } from 'react';
import type { Draft, SessionBriefEntry } from '../shared/ipc';
import { awaitsUser } from '../shared/items';
import { reviewStart } from '../shared/outputs';
import { hasReviewContent } from '../shared/review';
import { ContextMenu, type MenuPoint } from './ContextMenu';
import { DraftRow, SectionHeader } from './DraftList';
import type { DraftBook } from './drafts';
import { DeleteItem } from './FooterMenu';
import { useStore } from './hooks';
import type { ItemsStore } from './items';
import { ItemsView } from './ItemsView';
import { OutputsList } from './OutputsList';
import type { OutputsStore } from './outputs';
import { ReviewView, type ReviewDraft, type ReviewHost } from './ReviewView';
import type { ReviewVoice } from './review-voice';

export function ReviewMode(props: {
  book: DraftBook;
  items: ItemsStore;
  outputs: OutputsStore;
  /** The active session tab's brief. Review mode shows only on session tabs. */
  brief?: SessionBriefEntry;
  home: string;
  review: { host: ReviewHost; voice: ReviewVoice; onError: (message: string) => void };
  onOpenOutput: (sessionId: string, ref: string) => void;
  /** Hides an output until Claude writes it again. */
  onDismissOutput: (sessionId: string, ref: string) => void;
  onTrack: (sessionId: string, on: boolean) => void;
  /** Opens a file from an item's `Out:` lines. */
  onOpenItemOutput: (sessionId: string, path: string) => void;
  onSend: () => void;
}) {
  const book = useStore(props.book);
  const [menu, setMenu] = useState<MenuPoint & { id: string }>();
  const sessionId = props.brief?.sessionId;
  const held = (d: Draft) => !!d.review && hasReviewContent(d.review, d.body);
  const open = book.selected?.review && book.selected.sessionId === sessionId ? book.selected : undefined;
  // A review shows here once it holds a comment, a note or an edit, or while it is open.
  const reviews = book.drafts.filter((d) => d.review && d.sessionId === sessionId && (held(d) || d.id === open?.id));

  // Review opens on the work, once per visit to a session, so Back stays on the list.
  // It runs when the session changes and reads the rest as it stands then.
  const started = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!sessionId || started.current === sessionId) return;
    if (open) {
      started.current = sessionId;
      return;
    }
    let cancelled = false;
    const tracking = !!props.brief?.trackItems;
    void Promise.all([props.outputs.load(sessionId), tracking ? props.items.load(sessionId) : undefined])
      .catch(() => undefined)
      .then(() => {
        if (cancelled) return;
        started.current = sessionId;
        if (props.book.selected?.review) return;
        const start = reviewStart({
          reviews: props.book.drafts
            .filter((d) => d.review && d.sessionId === sessionId)
            .map((d) => ({ id: d.id, updatedAt: d.updatedAt, hasContent: held(d) })),
          outputs: props.outputs.info(sessionId)?.outputs ?? [],
          itemWaits: tracking && (props.items.doc(sessionId)?.doc.items ?? []).some(awaitsUser),
        });
        if (start && 'draftId' in start) props.book.select(start.draftId);
        else if (start) props.onOpenOutput(sessionId, start.ref);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  // A review takes the whole view, for the page's sake. The list stays mounted, so it comes back as it was.
  return (
    <div className={open ? 'write review-mode reviewing' : 'write review-mode'} data-testid="review-mode">
      <nav className="draft-list" aria-label="Outputs and reviews" hidden={!!open}>
        <div className="sections">
          {sessionId && (
            <OutputsList
              store={props.outputs}
              sessionId={sessionId}
              onOpen={(ref) => props.onOpenOutput(sessionId, ref)}
              onDismiss={(ref) => props.onDismissOutput(sessionId, ref)}
            />
          )}
          <section data-testid="reviews">
            <SectionHeader title="Reviews" count={reviews.length} />
            {reviews.length === 0 && <p className="muted empty">Open an HTML output to review it. Your comments wait here until you send them.</p>}
            <ul>
              {reviews.map((d) => (
                <DraftRow
                  key={d.id}
                  draft={d}
                  selected={false}
                  onSelect={() => book.select(d.id)}
                  onMenu={(e) => {
                    e.preventDefault();
                    setMenu({ id: d.id, x: e.clientX, y: e.clientY });
                  }}
                />
              ))}
            </ul>
          </section>
        </div>
      </nav>
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} label="Review" testId="row-menu" onClose={() => setMenu(undefined)}>
          <DeleteItem
            what="review"
            testId="row-menu-delete"
            onDelete={() => {
              book.remove(menu.id);
              setMenu(undefined);
            }}
          />
        </ContextMenu>
      )}
      {open ? (
        <ReviewView
          key={open.id}
          host={props.review.host}
          book={props.book}
          draft={open as ReviewDraft}
          voice={props.review.voice}
          onClose={() => book.select(undefined)}
          onSend={props.onSend}
          onError={props.review.onError}
        />
      ) : (
        <div className="review-side">
          <ItemsView
            store={props.items}
            brief={props.brief}
            home={props.home}
            onTrack={props.onTrack}
            onSend={props.onSend}
            onOpenOutput={props.onOpenItemOutput}
          />
        </div>
      )}
    </div>
  );
}
