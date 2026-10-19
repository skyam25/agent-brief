/**
 * Runs inside the HTML page the review pane shows. In comment mode it outlines the
 * element under the pointer and turns a click or a text selection into a pin.
 * It draws numbered markers for the pane's pins and forwards a few keys and links.
 * Edit mode, in edit-mode.ts, changes the page's elements and saves each change to the file.
 * It speaks to the pane only through postMessage.
 */

import { AT_ATTR, GROUND_ATTR, PASS_ATTR } from '../shared/review-edit';
import type { ReviewAnchor, ReviewRect } from '../shared/review';
import { createEditMode, type EditMode } from './edit-mode';
import { isTagged, REVIEW_SOURCE, type FromPage, type PagePin, type ToPage } from './messages';

/** The file's version, which the server puts on this script's tag. Read now, while this script runs. */
const VERSION = (document.currentScript as HTMLScriptElement | null)?.dataset.abVersion;

const MARKER = 22;
const ACCENT = '#6965db';
const HEADINGS = 'h1, h2, h3, h4, h5, h6';

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** Only the page the pane frames talks to it, not frames nested inside that page. */
if (window.parent !== window && window.parent === window.top) start();

function start(): void {
  const post = (m: FromPage) => window.parent.postMessage({ source: REVIEW_SOURCE, ...m }, '*');

  let commenting = false;
  let pins: PagePin[] = [];
  /** A selection just became a pin, so the click that ends it does nothing else. */
  let swallowClick = false;
  /** A selection became a pin, so the next pin list clears it. */
  let selectionPinned = false;
  let host: HTMLElement | undefined;
  let layer: HTMLDivElement | undefined;
  let hover: HTMLDivElement | undefined;
  let flash: HTMLDivElement | undefined;
  /** Outlines the element of the comment the pane has selected. */
  let selected: HTMLDivElement | undefined;
  let edit: EditMode | undefined;
  /** Where the pointer last was over the page. A scroll or pan moves the page under it. */
  let pointer: { x: number; y: number } | undefined;
  const markers = new Map<string, HTMLButtonElement>();
  /** Feedback items' selectors, from the pane. */
  let wheres: string[] = [];

  /** The selectors in `wheres` that `el` matches or sits inside. */
  const matching = (el: Element) =>
    wheres.filter((s) => {
      try { return !!el.closest(s); } catch { return false; }
    });

  /** The overlay's own elements sit in a closed shadow root, out of the page's CSS. */
  function mount(): void {
    host = document.createElement('agent-brief-overlay');
    host.style.cssText = 'all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483647;';
    const root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = `
      .box { position: fixed; pointer-events: none; border: 2px solid ${ACCENT}; border-radius: 4px;
        background: rgb(105 101 219 / 0.08); display: none; box-sizing: border-box; }
      .selected { border-style: solid; background: none; }
      .flash { border-color: ${ACCENT}; background: rgb(105 101 219 / 0.18); transition: opacity 0.6s ease 0.6s; }
      .pin { position: fixed; width: ${MARKER}px; height: ${MARKER}px; border-radius: 50% 50% 50% 2px;
        border: 2px solid #fff; background: ${ACCENT}; color: #fff; font: 600 11px/1 -apple-system, system-ui, sans-serif;
        display: flex; align-items: center; justify-content: center; padding: 0; cursor: pointer; pointer-events: auto;
        box-shadow: 0 1px 4px rgb(0 0 0 / 0.35); box-sizing: border-box; }
      .pin.active { outline: 3px solid rgb(105 101 219 / 0.35); transform: scale(1.15); }
    `;
    layer = document.createElement('div');
    hover = document.createElement('div');
    hover.className = 'box';
    flash = document.createElement('div');
    flash.className = 'box flash';
    selected = document.createElement('div');
    selected.className = 'box selected';
    root.append(style, selected, hover, flash, layer);
    document.documentElement.append(host);
    edit = createEditMode({ post, root, host: () => host, version: VERSION });
  }

  const place = (el: HTMLElement, r: DOMRect | ReviewRect, pad = 0) => {
    const left = 'left' in r ? r.left : r.x;
    const top = 'top' in r ? r.top : r.y;
    Object.assign(el.style, {
      display: 'block',
      left: `${left - pad}px`,
      top: `${top - pad}px`,
      width: `${r.width + pad * 2}px`,
      height: `${r.height + pad * 2}px`,
    });
  };

  const ours = (target: EventTarget | null) => target === host;

  /** Finds a pin's element, trying the selector without classes when the page changed them. */
  function find(selector: string): Element | null {
    for (const s of [selector, selector.replace(/\.[A-Za-z][\w-]*/g, '')]) {
      try {
        const el = document.querySelector(s);
        if (el) return el;
      } catch {
        // A selector the page's markup no longer parses as one.
      }
    }
    return null;
  }

  // ── Anchors ────────────────────────────────────────────────────────────

  const unique = (s: string) => {
    try {
      return document.querySelectorAll(s).length === 1;
    } catch {
      return false;
    }
  };

  /** A selector that names `el` alone: ids where the page has them, tags and nth-of-type elsewhere. */
  function selectorFor(el: Element): string {
    const stable = el.getAttribute('data-ui');
    if (stable) {
      const selector = `[data-ui="${CSS.escape(stable)}"]`;
      if (unique(selector)) return selector;
    }
    const parts: string[] = [];
    let cur: Element | null = el;
    while (cur && cur !== document.documentElement) {
      if (cur === document.body) {
        parts.unshift('body');
        break;
      }
      const id = cur.id && `#${CSS.escape(cur.id)}`;
      if (id && unique(id)) {
        parts.unshift(id);
        break;
      }
      const tag = cur.tagName.toLowerCase();
      const classes = [...cur.classList].filter((c) => /^[A-Za-z][\w-]*$/.test(c)).slice(0, 2);
      let part = tag + classes.map((c) => `.${c}`).join('');
      const parent: Element | null = cur.parentElement;
      if (parent) {
        const same = [...parent.children].filter((c) => c.tagName === cur!.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(cur) + 1})`;
      }
      parts.unshift(part);
      cur = parent;
    }
    return parts.join(' > ') || el.tagName.toLowerCase();
  }

  /** The last heading before `el` in document order, other than `el` itself. */
  function headingBefore(el: Element): string | undefined {
    let found: Element | undefined;
    for (const h of document.querySelectorAll(HEADINGS)) {
      if (h === el || h.contains(el)) continue;
      if (h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) found = h;
      else break;
    }
    const text = found && oneLine((found as HTMLElement).innerText ?? found.textContent ?? '');
    return text ? cut(text, 200) : undefined;
  }

  function anchorFor(el: Element, spot: { x: number; y: number }, quote?: string): ReviewAnchor {
    const r = el.getBoundingClientRect();
    const text = oneLine((el as HTMLElement).innerText ?? el.textContent ?? '');
    const heading = headingBefore(el);
    const fraction = (v: number, start: number, size: number) => (size > 0 ? Math.min(1, Math.max(0, (v - start) / size)) : 0.5);
    return {
      selector: selectorFor(el),
      tag: el.tagName.toLowerCase(),
      ...(quote ? { quote: cut(oneLine(quote), 2000) } : {}),
      ...(text ? { text: cut(text, 200) } : {}),
      ...(heading ? { heading } : {}),
      fx: fraction(spot.x, r.left, r.width),
      fy: fraction(spot.y, r.top, r.height),
      rect: { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height },
      scrollY,
      viewport: { width: innerWidth, height: innerHeight },
    };
  }

  /** The part of `r` inside the viewport. */
  const visible = (r: DOMRect): ReviewRect => {
    const x = Math.max(0, r.left);
    const y = Math.max(0, r.top);
    return { x, y, width: Math.max(0, Math.min(innerWidth, r.right) - x), height: Math.max(0, Math.min(innerHeight, r.bottom) - y) };
  };

  /** Hides the hover box and lets the page paint without it before the pane crops. */
  const afterPaint = (fn: () => void) => {
    if (hover) hover.style.display = 'none';
    requestAnimationFrame(() => requestAnimationFrame(fn));
  };

  function pinElement(el: Element, x: number, y: number): void {
    afterPaint(() => post({ type: 'pin', anchor: anchorFor(el, { x, y }), view: visible(el.getBoundingClientRect()), matches: matching(el) }));
  }

  function pinSelection(sel: Selection): boolean {
    const quote = sel.toString();
    if (!oneLine(quote) || sel.rangeCount === 0) return false;
    const range = sel.getRangeAt(0);
    const node = range.commonAncestorContainer;
    const el = node instanceof Element ? node : node.parentElement;
    if (!el || ours(el)) return false;
    const r = range.getBoundingClientRect();
    afterPaint(() => post({ type: 'pin', anchor: anchorFor(el, { x: r.right, y: r.top }, quote), view: visible(r), matches: matching(el) }));
    return true;
  }

  // ── Pins ───────────────────────────────────────────────────────────────

  /**
   * The element a comment on `target` pins to, or undefined for the page's background:
   * the root, the body, a ground the page marks as empty space, or the page's own controls.
   */
  function commentable(target: EventTarget | null): Element | undefined {
    if (!(target instanceof Element) || ours(target)) return undefined;
    if (target === document.documentElement || target === document.body) return undefined;
    if (target.hasAttribute(GROUND_ATTR) || target.closest(`[${PASS_ATTR}]`)) return undefined;
    return target;
  }

  /** Outlines the element under the pointer, or hides the box when there is none. */
  function placeHover(): void {
    if (!hover) return;
    const el = commenting && pointer ? commentable(document.elementFromPoint(pointer.x, pointer.y)) : undefined;
    if (!el) hover.style.display = 'none';
    else place(hover, el.getBoundingClientRect());
  }

  let queued = false;
  /** Moves markers to their elements, and the hover box to what is now under the pointer, on the next frame. */
  function layout(): void {
    edit?.layout();
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      placeHover();
      for (const pin of pins) {
        const marker = markers.get(pin.id);
        const el = find(pin.selector);
        const r = el?.getBoundingClientRect();
        if (!marker) continue;
        if (!r || (r.width === 0 && r.height === 0)) {
          marker.style.display = 'none';
          continue;
        }
        marker.style.display = 'flex';
        // The marker's pointed corner sits on the spot the user clicked.
        marker.style.left = `${r.left + pin.fx * r.width}px`;
        marker.style.top = `${r.top + pin.fy * r.height - MARKER}px`;
        if (pin.active && selected) place(selected, r, 3);
      }
      if (selected && !pins.some((p) => p.active && find(p.selector))) selected.style.display = 'none';
    });
  }

  function drawPins(next: PagePin[]): void {
    pins = next;
    if (!layer) return;
    for (const [id, marker] of markers) {
      if (pins.some((p) => p.id === id)) continue;
      marker.remove();
      markers.delete(id);
    }
    for (const pin of pins) {
      let marker = markers.get(pin.id);
      if (!marker) {
        marker = document.createElement('button');
        marker.className = 'pin';
        marker.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          post({ type: 'open-pin', id: pin.id });
        });
        markers.set(pin.id, marker);
        layer.append(marker);
      }
      marker.textContent = String(pin.n);
      marker.title = `Comment ${pin.n}`;
      marker.classList.toggle('active', !!pin.active);
    }
    post({ type: 'missing', ids: pins.filter((p) => !find(p.selector)).map((p) => p.id) });
    layout();
  }

  function show(id: string): void {
    const pin = pins.find((p) => p.id === id);
    const el = pin && find(pin.selector);
    if (!el || !flash) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    const box = flash;
    setTimeout(() => {
      place(box, el.getBoundingClientRect(), 4);
      box.style.opacity = '1';
      requestAnimationFrame(() => (box.style.opacity = '0'));
      setTimeout(() => (box.style.display = 'none'), 1300);
    }, 350);
  }

  function setCommenting(on: boolean): void {
    commenting = on;
    if (on) document.documentElement.setAttribute('data-agent-brief-commenting', '');
    else document.documentElement.removeAttribute('data-agent-brief-commenting');
    if (!on && hover) hover.style.display = 'none';
  }

  // ── Events ─────────────────────────────────────────────────────────────

  window.addEventListener('message', (e) => {
    if (e.source !== window.parent || !isTagged(e.data)) return;
    const m = e.data as unknown as ToPage;
    if (m.type === 'commenting') setCommenting(m.on);
    if (m.type === 'pins') {
      drawPins(m.pins);
      // A selection that became a pin has done its job.
      if (selectionPinned) getSelection()?.removeAllRanges();
      selectionPinned = false;
    }
    if (m.type === 'show') show(m.id);
    if (m.type === 'where') wheres = m.selectors.filter((s) => typeof s === 'string').slice(0, 500);
    if (m.type === 'scroll-to' && Number.isFinite(m.x) && Number.isFinite(m.y)) scrollTo({ left: m.x, top: m.y, behavior: 'instant' });
    if (m.type === 'show-behavior') {
      let element: Element | null = null;
      try { if (document.querySelectorAll(m.selector).length === 1) element = document.querySelector(m.selector); } catch { /* stale or invalid target */ }
      if (element && element.getBoundingClientRect().width && element.getBoundingClientRect().height) {
        element.scrollIntoView({ block: 'center', behavior: 'instant' });
        element.animate([{ outline: '3px solid #8b5cf6', outlineOffset: '3px' }, { outline: '3px solid transparent', outlineOffset: '3px' }], { duration: 1300 });
      } else window.parent.postMessage({ source: REVIEW_SOURCE, type: 'behavior-missing' }, '*');
    }
    if (m.type === 'measure') {
      let element: Element | null = null;
      try { if (document.querySelectorAll(m.selector).length === 1) element = document.querySelector(m.selector); } catch { /* stale or invalid target */ }
      element?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
      afterPaint(() => {
        const view = element ? visible(element.getBoundingClientRect()) : undefined;
        post({ type: 'measured', id: m.id, ...(view?.width && view.height ? { view } : {}) });
      });
    }
    if (m.type === 'editing') {
      if (m.on) setCommenting(false);
      edit?.setEditing(m.on);
    }
    if (m.type === 'edited') edit?.onEdited(m.result);
    if (m.type === 'style') edit?.style(m.set);
    if (m.type === 'text') edit?.text(m.text);
    if (m.type === 'act') edit?.act(m.act);
    if (m.type === 'insert') edit?.insert(m.what);
  });

  const editable = (t: EventTarget | null) =>
    t instanceof HTMLElement && (t.isContentEditable || t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement);

  function listen(): void {
    const cursor = document.createElement('style');
    cursor.textContent = 'html[data-agent-brief-commenting], html[data-agent-brief-commenting] * { cursor: crosshair !important; }';
    document.head.append(cursor);

    document.addEventListener(
      'pointermove',
      (e) => {
        pointer = { x: e.clientX, y: e.clientY };
        if (commenting) placeHover();
      },
      true,
    );
    document.documentElement.addEventListener('pointerleave', () => {
      pointer = undefined;
      placeHover();
    });
    // The page does not see presses in comment mode, but a drag still selects text.
    for (const type of ['pointerdown', 'mousedown', 'pointerup']) {
      document.addEventListener(
        type,
        (e) => {
          if (type === 'pointerdown') swallowClick = false;
          if (commenting && !ours(e.target)) e.stopPropagation();
        },
        true,
      );
    }
    document.addEventListener(
      'mouseup',
      (e) => {
        if (!commenting || ours(e.target)) return;
        e.stopPropagation();
        const sel = getSelection();
        if (sel && !sel.isCollapsed && pinSelection(sel)) swallowClick = selectionPinned = true;
      },
      true,
    );
    document.addEventListener(
      'click',
      (e) => {
        if (ours(e.target)) return;
        if (wheres.length && e.target instanceof Element) post({ type: 'pointed', matches: matching(e.target) });
        if (commenting) {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          if (swallowClick) {
            swallowClick = false;
            return;
          }
          const el = commentable(e.target);
          if (el) pinElement(el, e.clientX, e.clientY);
          return;
        }
        const link = e.target instanceof Element ? e.target.closest('a[href]') : null;
        if (!(link instanceof HTMLAnchorElement)) return;
        const url = new URL(link.href, location.href);
        if (url.protocol === location.protocol) return;
        e.preventDefault();
        if (url.protocol === 'http:' || url.protocol === 'https:') post({ type: 'link', href: url.href });
      },
      true,
    );
    document.addEventListener(
      'keydown',
      (e) => {
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        if (e.key === 'Escape') {
          post({ type: 'key', key: 'Escape' });
          if (commenting) e.preventDefault();
        } else if ((e.key === 'c' || e.key === 'C') && !editable(e.target)) {
          e.preventDefault();
          post({ type: 'key', key: 'c' });
        } else if ((e.key === 'e' || e.key === 'E') && !editable(e.target)) {
          e.preventDefault();
          post({ type: 'key', key: 'e' });
        }
      },
      true,
    );
    addEventListener('scroll', layout, { capture: true, passive: true });
    // The pane keeps where the page rests, so a reload can put it back.
    let resting: ReturnType<typeof setTimeout> | undefined;
    addEventListener('scroll', () => {
      clearTimeout(resting);
      resting = setTimeout(() => post({ type: 'scrolled', x: Math.round(scrollX), y: Math.round(scrollY) }), 150);
    }, { passive: true });
    addEventListener('resize', layout);
    // Pages that animate or load late move elements without a scroll.
    setInterval(layout, 1000);
  }

  const ready = () => {
    mount();
    listen();
    drawPins(pins);
    post({
      type: 'ready',
      path: decodeURIComponent(location.pathname).replace(/^\/+/, ''),
      title: document.title,
      ...(VERSION ? { version: VERSION, editable: !!document.querySelector(`[${AT_ATTR}]`) } : {}),
    });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready, { once: true });
  else ready();
}
