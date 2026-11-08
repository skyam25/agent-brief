/**
 * A page hand-off: the project's HTML page in a frame, with the review overlay inside it, as in the Mac's Review pane.
 * A pin on the page is a comment in the panel, and the panel's selection outlines its element.
 */

import { useEffect, useRef } from 'react';
import type { BoardCommentsStore } from '../renderer/board-comments';
import { isTagged, REVIEW_SOURCE, type FromPage, type PagePin, type ToPage } from '../review/messages';
import type { ReviewComment } from '../shared/review';
import { toNative, type IpadHost } from './host';

/** The page's comments as a review Send hands them over: pins with their place on the page. */
export function pageComments(host: IpadHost, comments: BoardCommentsStore, board: string): ReviewComment[] {
  return comments.of(board).pins.flatMap((p) => {
    const anchor = host.anchorOf(board, p.id);
    return anchor ? [{ id: p.id, text: p.text, anchor, createdAt: p.createdAt }] : [];
  });
}

export function PageFrame(props: { url: string; board: string; host: IpadHost; comments: BoardCommentsStore }) {
  const { url, board, host, comments } = props;
  const frame = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const post = (m: ToPage) => frame.current?.contentWindow?.postMessage({ source: REVIEW_SOURCE, ...m }, '*');
    const pins = (): PagePin[] =>
      comments.of(board).pins.flatMap((p, i) => {
        const anchor = host.anchorOf(board, p.id);
        return anchor ? [{ id: p.id, n: i + 1, selector: anchor.selector, fx: anchor.fx, fy: anchor.fy, active: p.id === comments.selected }] : [];
      });
    const sync = () => {
      post({ type: 'commenting', on: comments.tool });
      post({ type: 'pins', pins: pins() });
    };

    const onMessage = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow || !isTagged(e.data)) return;
      const m = e.data as unknown as FromPage;
      if (m.type === 'ready') sync();
      else if (m.type === 'pin') {
        const words = m.anchor.quote ?? m.anchor.text;
        const id = comments.add(board, { x: 0, y: 0, type: m.anchor.tag, ...(words ? { label: words } : {}) });
        if (id) host.setAnchor(board, id, m.anchor);
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
    </div>
  );
}
