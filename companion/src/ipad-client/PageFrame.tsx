/**
 * A page hand-off: the project's HTML page in a frame, with the review overlay inside it, as in the Mac's Review pane.
 * A pin on the page is a comment in the panel, and the panel's selection outlines its element.
 */

import { useEffect, useRef } from 'react';
import type { BoardCommentsStore } from '../renderer/board-comments';
import { isTagged, pagePin, REVIEW_SOURCE, type FromPage, type ToPage } from '../review/messages';
import type { ReviewAnchor, ReviewComment } from '../shared/review';
import { toNative, type IpadHost } from './host';

/** The board's pins that sit on the page, numbered as the panel lists them. A pin lands once its anchor is set. */
const anchored = (host: IpadHost, comments: BoardCommentsStore, board: string) =>
  comments.of(board).pins.flatMap((pin, i) => {
    const anchor = host.anchorOf(board, pin.id);
    return anchor ? [{ pin, anchor, n: i + 1 }] : [];
  });

/** The page's comments as a review Send hands them over: pins with their place on the page. */
export const pageComments = (host: IpadHost, comments: BoardCommentsStore, board: string): ReviewComment[] =>
  anchored(host, comments, board).map(({ pin, anchor }) => ({ id: pin.id, text: pin.text, anchor, createdAt: pin.createdAt }));

/** A pin card's label: the element's tag and the words it shows. */
const label = (anchor: ReviewAnchor) => {
  const words = anchor.quote ?? anchor.text;
  return { type: anchor.tag, ...(words ? { label: words } : {}) };
};

export function PageFrame(props: { url: string; board: string; host: IpadHost; comments: BoardCommentsStore }) {
  const { url, board, host, comments } = props;
  const frame = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const post = (m: ToPage) => frame.current?.contentWindow?.postMessage({ source: REVIEW_SOURCE, ...m }, '*');

    // Typing in a card leaves the pins as they are, so the page hears only real changes. A fresh page hears everything.
    let sent = '';
    const sync = (fresh = false) => {
      const pins = anchored(host, comments, board).map(({ pin, anchor, n }) => pagePin(pin.id, n, anchor, pin.id === comments.selected));
      const key = JSON.stringify([comments.tool, pins]);
      if (key === sent && !fresh) return;
      sent = key;
      post({ type: 'commenting', on: comments.tool });
      post({ type: 'pins', pins });
    };

    const onMessage = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow || !isTagged(e.data)) return;
      const m = e.data as unknown as FromPage;
      if (m.type === 'ready') sync(true);
      else if (m.type === 'pin') {
        const id = comments.add(board, { x: 0, y: 0, ...label(m.anchor) });
        if (!id) return;
        host.setAnchor(board, id, m.anchor);

        // The marker draws now that its anchor is known.
        sync();
      } else if (m.type === 'move-pin') {
        if (!comments.of(board).pins.some((p) => p.id === m.id)) return;
        host.setAnchor(board, m.id, m.anchor);
        comments.relabel(board, m.id, label(m.anchor));
        comments.select(m.id);
      } else if (m.type === 'open-pin') comments.select(m.id);
      else if (m.type === 'link') toNative({ type: 'openLink', href: m.href });
    };
    window.addEventListener('message', onMessage);

    // The page follows the panel: the pin tool, the pins, and the selected comment's element.
    let selected = comments.selected;
    const stop = comments.subscribe(() => {
      sync();
      if (comments.selected === selected) return;
      selected = comments.selected;
      if (selected && host.anchorOf(board, selected)) post({ type: 'show', id: selected });
    });
    return () => {
      window.removeEventListener('message', onMessage);
      stop();
    };
  }, [board, comments, host]);

  return (
    <div className="ipad-page" data-testid="ipad-page">
      <iframe ref={frame} src={url} title="Page under review" data-testid="ipad-page-frame" />
      {comments.tool && (
        <div className="ipad-page-hint" role="status" data-testid="page-pin-hint">
          <span>Tap the page to pin comments</span>
          <button onClick={() => comments.setTool(false)} data-testid="page-pin-done">
            Done
          </button>
        </div>
      )}
    </div>
  );
}
