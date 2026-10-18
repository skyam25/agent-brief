/**
 * Review mode: what Claude hands back for the active session. The list holds its
 * outputs, the reviews in progress and its items. The pane beside it shows the one picked.
 */

import { useEffect, useRef, useState } from 'react';
import type { Draft, SessionBriefEntry } from '../shared/ipc';
import { awaitsUser } from '../shared/items';
import { reviewStart } from '../shared/outputs';
import { hasReviewContent } from '../shared/review';
import { ContextMenu, type MenuPoint } from './ContextMenu';
import { DraftRow, SectionHeader } from './DraftList';
import type { DraftBook } from './drafts';
import { FeedbackView, useFeedbackFiles, type SendFeedback } from './FeedbackPanel';
import { DeleteItem } from './FooterMenu';
import { useStore } from './hooks';
import type { ItemsStore } from './items';
import { ItemsView } from './ItemsView';
import { OutputsList } from './OutputsList';
import type { OutputsStore } from './outputs';
import { ReviewView, type ReviewDraft, type ReviewHost } from './ReviewView';
import type { ReviewVoice } from './review-voice';

/** Room for the list (260), a page worth reading and its comments, side by side. */
const ROOM_FOR_LIST = 1180;

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
  onSendFeedback: SendFeedback;
}) {
  const book = useStore(props.book);
  const items = useStore(props.items);
  const outputs = useStore(props.outputs);
  const [menu, setMenu] = useState<MenuPoint & { id: string }>();
  /** The list toggle's choice. Until there is one, the list shows when the view is wide enough. */
  const [listWanted, setListWanted] = useState<boolean>();
  const root = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(true);
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const watch = new ResizeObserver(([entry]) => setWide(entry!.contentRect.width >= ROOM_FOR_LIST));
    watch.observe(el);
    return () => watch.disconnect();
  }, []);
  /** The items were picked, so the pane shows them rather than a page. */
  const [itemsPicked, setItemsPicked] = useState(false);
  /** An output whose Feedback view fills the pane. */
  const [feedbackFor, setFeedbackFor] = useState<string>();
  const sessionId = props.brief?.sessionId;
  const feedbackFiles = useFeedbackFiles(props.review.host, sessionId);
  const tracking = !!props.brief?.trackItems;
  const held = (d: Draft) => !!d.review && hasReviewContent(d.review, d.body);
  const open = book.selected?.review && book.selected.sessionId === sessionId ? book.selected : undefined;
  // Only the review pane can hide the list, so the list always shows beside the items.
  const listOpen = !open || (listWanted ?? wide);
  // A review shows here once it holds a comment, a note or an edit. Until then its output row marks it.
  const reviews = book.drafts.filter((d) => d.review && d.sessionId === sessionId && held(d));
  const list = sessionId ? items.doc(sessionId)?.doc.items : undefined;
  const openItems = list?.filter((i) => !i.done).length ?? 0;
  const waiting = list?.filter(awaitsUser).length ?? 0;

  useEffect(() => {
    setItemsPicked(false);
    setFeedbackFor(undefined);
  }, [sessionId]);

  // With nothing picked, the pane opens on the work: the newest review, else the newest Ready page.
  // It waits for the session's lists, and tries each choice once, so a page that fails to open leaves the items in view.
  const outputsInfo = sessionId ? outputs.info(sessionId) : undefined;
  const itemsInfo = sessionId ? items.doc(sessionId) : undefined;
  const tried = useRef(new Set<string>());
  useEffect(() => {
    if (!sessionId || open || itemsPicked || feedbackFor) return;
    if (!outputsInfo) {
      void props.outputs.load(sessionId).catch(() => undefined);
      return;
    }
    if (tracking && !itemsInfo) {
      void props.items.load(sessionId).catch(() => undefined);
      return;
    }
    const start = reviewStart({
      reviews: props.book.drafts
        .filter((d) => d.review && d.sessionId === sessionId)
        .map((d) => ({ id: d.id, updatedAt: d.updatedAt, hasContent: held(d) })),
      outputs: outputsInfo.outputs,
      itemWaits: tracking && (itemsInfo?.doc.items ?? []).some(awaitsUser),
    });
    if (!start) return;
    const key = `${sessionId}:${'draftId' in start ? start.draftId : start.ref}`;
    if (tried.current.has(key)) return;
    tried.current.add(key);
    if ('draftId' in start) props.book.select(start.draftId);
    else props.onOpenOutput(sessionId, start.ref);
  }, [sessionId, open?.id, itemsPicked, feedbackFor, tracking, outputsInfo, itemsInfo]);

  const pickItems = () => {
    setItemsPicked(true);
    setFeedbackFor(undefined);
    if (open) book.select(undefined);
  };
  const openOutput = (ref: string) => {
    setItemsPicked(false);
    setFeedbackFor(undefined);
    if (sessionId) props.onOpenOutput(sessionId, ref);
  };
  const openFeedback = (ref: string) => {
    setItemsPicked(false);
    setFeedbackFor(ref);
    if (open) book.select(undefined);
  };

  return (
    <div className="write review-mode" ref={root} data-testid="review-mode">
      <nav className="draft-list" aria-label="Outputs, reviews and items" hidden={!listOpen}>
        <div className="sections">
          {sessionId && (
            <OutputsList
              store={props.outputs}
              sessionId={sessionId}
              selectedRef={open?.review?.path ?? feedbackFor}
              onOpen={openOutput}
              onDismiss={(ref) => props.onDismissOutput(sessionId, ref)}
              feedback={feedbackFiles}
              onFeedback={openFeedback}
            />
          )}
          {reviews.length > 0 && (
            <section data-testid="reviews">
              <SectionHeader title="Reviews" count={reviews.length} />
              <ul>
                {reviews.map((d) => (
                  <DraftRow
                    key={d.id}
                    draft={d}
                    selected={d.id === open?.id}
                    onSelect={() => {
                      setItemsPicked(false);
                      setFeedbackFor(undefined);
                      book.select(d.id);
                    }}
                    onMenu={(e) => {
                      e.preventDefault();
                      setMenu({ id: d.id, x: e.clientX, y: e.clientY });
                    }}
                  />
                ))}
              </ul>
            </section>
          )}
          <section>
            <SectionHeader title="Items" count={tracking ? openItems : 0} />
            <ul>
              <li>
                <button className="ghost draft-row" aria-current={!open && !feedbackFor} onClick={pickItems} data-testid="items-row">
                  <span className="lines">
                    <span className="title-line">
                      <span className="title">{tracking ? `${openItems} open` : 'Not tracked'}</span>
                    </span>
                    <span className="muted preview">
                      {tracking ? (waiting > 0 ? `${waiting} waiting on you` : 'Nothing waits on you') : 'Turn on to have Claude list its questions'}
                    </span>
                  </span>
                </button>
              </li>
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
          listOpen={listOpen}
          onToggleList={() => setListWanted(!listOpen)}
          onSend={props.onSend}
          onSendFeedback={props.onSendFeedback}
          canSend={!!props.brief?.isLive}
          onError={props.review.onError}
        />
      ) : feedbackFor && sessionId ? (
        <div className="review-side">
          <FeedbackView
            key={feedbackFor}
            host={props.review.host}
            sessionId={sessionId}
            path={feedbackFor}
            canSend={!!props.brief?.isLive}
            onSend={props.onSendFeedback}
            onOpenFile={() => props.onOpenOutput(sessionId, feedbackFor)}
            onError={props.review.onError}
          />
        </div>
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
