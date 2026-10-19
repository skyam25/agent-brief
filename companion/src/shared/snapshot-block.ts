/**
 * The block an element's snapshot shows, so the picture carries what surrounds it:
 * the element or its nearest ancestor that is a section, article, aside, form, dialog,
 * figure or card, or measures at least 320×160. The body and root never count.
 *
 * Runs in the page. The snap passes its source into the page, so it uses nothing outside itself.
 */
export function snapshotBlock(el: Element): Element {
  for (let cur: Element | null = el; cur && cur.tagName !== 'BODY' && cur.tagName !== 'HTML'; cur = cur.parentElement) {
    const r = cur.getBoundingClientRect();
    if (cur.matches('section, article, aside, form, dialog, figure, [class*="card"]') || (r.width >= 320 && r.height >= 160)) return cur;
  }
  return el;
}

/** The outline drawn around the element itself in a snapshot. */
export const SNAPSHOT_MARK = { color: '#8b5cf6', width: 3 };
