/**
 * Edit mode for the page in the review pane. A click selects an element, a drag
 * moves it into another place or container, the corner handle resizes it, and a
 * double click retypes its words. Each change shows at once and goes to the pane
 * as one edit, one at a time. Main's answer renumbers the page's `data-ab-at`
 * values so the next edit names elements as the file now has them.
 */

import { AT_ATTR, GROUND_ATTR, INSERTS, INSPECTOR_PROPS, PAGE_EDIT_EVENT, PASS_ATTR } from '../shared/review-edit';
import type { EditResult, InsertKind, ReviewEdit, SelectedElement, StyleSet } from '../shared/review-edit';
import type { FromPage } from './messages';

const EDIT = '#2f7cf6';
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
/** How far a press moves before it counts as a drag. */
const DRAG_SLOP = 4;
const SVG_NS = 'http://www.w3.org/2000/svg';

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

type Axis = 'x' | 'y';
type Drop = { container: Element; before: Element | null };

export interface EditMode {
  readonly editing: boolean;
  setEditing(on: boolean): void;
  onEdited(result: EditResult): void;
  style(set: StyleSet): void;
  text(text: string): void;
  act(act: 'parent' | 'duplicate' | 'remove' | 'deselect'): void;
  insert(what: InsertKind): void;
  /** Moves the boxes to their elements. The overlay calls it on scroll, resize and a timer. */
  layout(): void;
}

export function createEditMode(deps: { post: (m: FromPage) => void; root: ShadowRoot; host: () => HTMLElement | undefined; version?: string }): EditMode {
  const { post } = deps;
  let editing = false;
  let version = deps.version;
  let sel: Element | undefined;
  let hovered: Element | undefined;
  let typing: { el: Element; before: string } | undefined;
  let press: { el: Element; x: number; y: number } | undefined;
  let drag: { el: Element; drop?: Drop } | undefined;
  let sizing: { el: HTMLElement; x: number; y: number; w: number; h: number; scale: number } | undefined;
  /** Edits wait here while one is with main. Each builds itself when its turn comes. */
  const queue: (() => ReviewEdit | undefined)[] = [];
  let waiting = false;
  /** Select the element main names in its answer. */
  let follow = false;

  const style = document.createElement('style');
  style.textContent = `
    .e { position: fixed; pointer-events: none; box-sizing: border-box; display: none; }
    .hover { border: 1px dashed ${EDIT}; border-radius: 3px; }
    .sel { border: 2px solid ${EDIT}; border-radius: 3px; }
    .tag { position: fixed; display: none; pointer-events: none; padding: 1px 5px; border-radius: 4px; background: ${EDIT};
      color: #fff; font: 600 10px/16px -apple-system, system-ui, sans-serif; white-space: nowrap; }
    .handle { position: fixed; display: none; width: 10px; height: 10px; border: 2px solid ${EDIT}; border-radius: 2px;
      background: #fff; box-sizing: border-box; pointer-events: auto; cursor: nwse-resize; }
    .into { border: 2px dashed ${EDIT}; border-radius: 4px; background: rgb(47 124 246 / 0.06); }
    .line { background: ${EDIT}; border-radius: 2px; }
    .ghost { border: 2px solid ${EDIT}; border-radius: 4px; background: rgb(47 124 246 / 0.12); opacity: 0.9; }
  `;
  const box = (cls: string) => {
    const el = document.createElement('div');
    el.className = `e ${cls}`;
    return el;
  };
  const hoverBox = box('hover');
  const selBox = box('sel');
  const intoBox = box('into');
  const line = box('line');
  const ghost = box('ghost');
  const tag = document.createElement('div');
  tag.className = 'tag';
  const handle = document.createElement('div');
  handle.className = 'handle';
  handle.title = 'Drag to resize';
  deps.root.append(style, hoverBox, intoBox, line, ghost, selBox, tag, handle);

  const page = document.createElement('style');
  page.textContent = `
    html[data-agent-brief-editing] body, html[data-agent-brief-editing] body * { user-select: none; -webkit-user-select: none; }
    html[data-agent-brief-editing] [contenteditable] { user-select: text; -webkit-user-select: text; cursor: text; outline: none; }
  `;

  const put = (el: HTMLElement, r: { left: number; top: number; width: number; height: number }, pad = 0) =>
    Object.assign(el.style, { display: 'block', left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px` });
  const hide = (...els: HTMLElement[]) => els.forEach((el) => (el.style.display = 'none'));

  // ── The page's elements ────────────────────────────────────────────────

  const atOf = (el: Element) => Number(el.getAttribute(AT_ATTR));
  const isGround = (el: Element) => el.hasAttribute(GROUND_ATTR);

  /** The editable element a press on `target` lands on, or undefined when the press belongs to the page. */
  function editableOf(target: EventTarget | null): Element | undefined {
    if (!(target instanceof Element) || target === deps.host()) return undefined;
    if (target.closest(`[${PASS_ATTR}]`)) return undefined;
    const el = target.closest(`[${AT_ATTR}]`);
    return el && !isGround(el) ? el : undefined;
  }

  const parentOf = (el: Element): Element | undefined => {
    const p = el.parentElement?.closest(`[${AT_ATTR}]`);
    return p && !isGround(p) ? p : undefined;
  };
  const kids = (el: Element, skip?: Element) => [...el.children].filter((c) => c.hasAttribute(AT_ATTR) && c !== skip);

  /** The words of an element: all of them for a text-only element, else its one direct run of text. */
  function wordsOf(el: Element): { text: string; node?: Text } | undefined {
    if (el.children.length === 0) return { text: el.textContent ?? '' };
    const runs = [...el.childNodes].filter((n): n is Text => n.nodeType === Node.TEXT_NODE && !!oneLine(n.textContent ?? ''));
    return runs.length === 1 ? { text: oneLine(runs[0]!.textContent ?? ''), node: runs[0] } : undefined;
  }

  function isContainer(el: Element): boolean {
    const name = el.tagName.toLowerCase();
    if (VOID.has(name) || (el.namespaceURI === SVG_NS && name !== 'svg') || name === 'svg') return false;
    if (kids(el).length > 0) return true;
    return !oneLine(el.textContent ?? '');
  }

  const labelOf = (el: Element) => {
    const words = oneLine((el as HTMLElement).innerText ?? el.textContent ?? '');
    return words ? `${el.tagName.toLowerCase()} “${cut(words, 40)}”` : el.tagName.toLowerCase();
  };

  function describe(el: Element): SelectedElement {
    const css = getComputedStyle(el);
    const inline: SelectedElement['inline'] = {};
    const computed: SelectedElement['computed'] = {};
    for (const prop of INSPECTOR_PROPS) {
      const own = (el as HTMLElement).style?.getPropertyValue(prop);
      if (own) inline[prop] = own;
      computed[prop] = css.getPropertyValue(prop);
    }
    const words = wordsOf(el);
    return {
      at: atOf(el),
      label: labelOf(el),
      ...(words ? { text: words.text } : {}),
      inline,
      computed,
      isContainer: isContainer(el),
      hasParent: !!parentOf(el),
    };
  }

  // ── Selection and boxes ────────────────────────────────────────────────

  function select(el: Element | undefined): void {
    sel = el;
    post({ type: 'selected', element: el ? describe(el) : null });
    layout();
  }

  function layout(): void {
    if (!editing) return;
    if (hovered && hovered !== sel && !drag && hovered.isConnected) put(hoverBox, hovered.getBoundingClientRect());
    else hide(hoverBox);
    if (!sel || !sel.isConnected) {
      hide(selBox, tag, handle);
      return;
    }
    const r = sel.getBoundingClientRect();
    put(selBox, r, 1);
    // CSS pixels, so a zoomed canvas still shows the sizes the inspector edits.
    const size = sel instanceof HTMLElement ? [sel.offsetWidth, sel.offsetHeight] : [r.width, r.height];
    tag.textContent = `${sel.tagName.toLowerCase()}  ${Math.round(size[0]!)}×${Math.round(size[1]!)}`;
    Object.assign(tag.style, { display: 'block', left: `${r.left - 1}px`, top: `${Math.max(0, r.top - 19)}px` });
    const resizable = sel instanceof HTMLElement && !typing;
    if (resizable) Object.assign(handle.style, { display: 'block', left: `${r.right - 5}px`, top: `${r.bottom - 5}px` });
    else hide(handle);
  }

  // ── Saving edits ───────────────────────────────────────────────────────

  function enqueue(make: () => ReviewEdit | undefined): void {
    queue.push(make);
    pump();
  }

  function pump(): void {
    if (waiting || !version) return;
    while (queue.length) {
      const edit = queue.shift()!();
      if (!edit) continue;
      waiting = true;
      post({ type: 'edit', version, edit });
      return;
    }
  }

  function onEdited(result: EditResult): void {
    waiting = false;
    if (!result.ok) {
      // The pane reloads the page, which drops what this one shows.
      queue.length = 0;
      return;
    }
    version = result.version;
    const els = [...document.querySelectorAll(`[${AT_ATTR}]`)];
    if (els.length !== result.offsets.length) {
      queue.length = 0;
      post({ type: 'reload' });
      return;
    }
    els.forEach((el, i) => el.setAttribute(AT_ATTR, String(result.offsets[i])));
    if (follow && result.at !== undefined) select(document.querySelector(`[${AT_ATTR}="${result.at}"]`) ?? undefined);
    else if (sel?.isConnected) select(sel);
    follow = false;
    pump();
  }

  function setStyle(el: Element, set: StyleSet): void {
    const s = (el as HTMLElement).style;
    if (!s) return;
    for (const [prop, value] of Object.entries(set)) {
      if (value === null || !value.trim()) s.removeProperty(prop);
      else s.setProperty(prop, value.trim());
    }
  }

  function saveStyle(el: Element, set: StyleSet): void {
    const clean: StyleSet = {};
    for (const [k, v] of Object.entries(set)) clean[k] = v === null || !v.trim() ? null : v.trim();
    setStyle(el, clean);
    layout();
    enqueue(() => ({ kind: 'style', at: atOf(el), set: clean }));
  }

  function saveText(el: Element, text: string): void {
    const words = wordsOf(el);
    if (!words || words.text === text) return;
    if (words.node) words.node.textContent = text;
    else el.textContent = text;
    enqueue(() => ({ kind: 'text', at: atOf(el), text }));
  }

  // ── Typing in place ────────────────────────────────────────────────────

  function startTyping(el: Element): void {
    const words = wordsOf(el);
    if (!words || words.node || !(el instanceof HTMLElement)) return;
    typing = { el, before: el.textContent ?? '' };
    el.setAttribute('contenteditable', 'plaintext-only');
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    getSelection()?.removeAllRanges();
    getSelection()?.addRange(range);
    el.addEventListener('blur', () => stopTyping(true), { once: true });
    layout();
  }

  function stopTyping(keep: boolean): void {
    if (!typing) return;
    const { el, before } = typing;
    typing = undefined;
    el.removeAttribute('contenteditable');
    getSelection()?.removeAllRanges();
    const text = el.textContent ?? '';
    if (!keep) el.textContent = before;
    else if (text !== before) enqueue(() => ({ kind: 'text', at: atOf(el), text }));
    if (sel === el) select(el);
  }

  // ── Dropping ───────────────────────────────────────────────────────────

  function axisOf(c: Element): Axis {
    const css = getComputedStyle(c);
    if (css.display.includes('flex')) return css.flexDirection.startsWith('row') ? 'x' : 'y';
    const k = kids(c);
    if (k.length >= 2) {
      const a = k[0]!.getBoundingClientRect();
      const b = k[1]!.getBoundingClientRect();
      return Math.abs(a.top - b.top) < 4 && b.left > a.left ? 'x' : 'y';
    }
    return 'y';
  }

  const mid = (r: DOMRect, axis: Axis) => (axis === 'x' ? r.left + r.width / 2 : r.top + r.height / 2);

  function dropAt(x: number, y: number, moving: Element): Drop | undefined {
    let target: Element | undefined;
    for (const hit of document.elementsFromPoint(x, y)) {
      const el = editableOf(hit);
      if (el && !moving.contains(el)) {
        target = el;
        break;
      }
    }
    if (!target) return undefined;
    const parent = parentOf(target);
    const r = target.getBoundingClientRect();
    const nearEdge = () => {
      if (!parent) return false;
      const axis = axisOf(parent);
      const [p, start, size] = axis === 'x' ? [x, r.left, r.width] : [y, r.top, r.height];
      const edge = Math.min(12, size / 4);
      return p - start < edge || start + size - p < edge;
    };
    if (isContainer(target) && !nearEdge()) {
      const axis = axisOf(target);
      const p = axis === 'x' ? x : y;
      const before = kids(target, moving).find((k) => mid(k.getBoundingClientRect(), axis) > p) ?? null;
      return { container: target, before };
    }
    if (!parent) return undefined;
    const axis = axisOf(parent);
    if ((axis === 'x' ? x : y) < mid(r, axis)) return { container: parent, before: target };
    const siblings = kids(parent, moving);
    return { container: parent, before: siblings[siblings.indexOf(target) + 1] ?? null };
  }

  function drawDrop(drop: Drop | undefined, moving: Element): void {
    if (!drop) {
      hide(intoBox, line);
      return;
    }
    const c = drop.container.getBoundingClientRect();
    put(intoBox, c, 2);
    const axis = axisOf(drop.container);
    const others = kids(drop.container, moving);
    const at = drop.before?.getBoundingClientRect();
    const last = others.at(-1)?.getBoundingClientRect();
    if (!at && !last) {
      hide(line);
      return;
    }
    if (axis === 'y') {
      const top = at ? at.top - 2 : last!.bottom + 1;
      put(line, { left: c.left + 2, top, width: Math.max(0, c.width - 4), height: 3 });
    } else {
      const left = at ? at.left - 2 : last!.right + 1;
      const ref = at ?? last!;
      put(line, { left, top: ref.top, width: 3, height: ref.height });
    }
  }

  function finishDrag(): void {
    const d = drag;
    drag = undefined;
    hide(intoBox, line, ghost);
    if (!d?.drop) return;
    const { el } = d;
    const { container, before } = d.drop;
    if (before === el) return;
    enqueue(() => {
      if (!el.isConnected || !container.isConnected) return undefined;
      const at = atOf(el);
      container.insertBefore(el, before);
      follow = true;
      return { kind: 'move', at, parent: atOf(container), before: before ? atOf(before) : null };
    });
  }

  // ── Events ─────────────────────────────────────────────────────────────

  const block = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  };
  const inTyping = (t: EventTarget | null) => !!typing && t instanceof Node && typing.el.contains(t);

  // Window capture runs before any listener the page adds, so presses on editable elements never reach it.
  addEventListener(
    'pointerdown',
    (e) => {
      if (!editing || e.button !== 0 || inTyping(e.target)) return;
      if (typing) stopTyping(true);
      const el = editableOf(e.target);
      if (!el) return;
      block(e);
      press = { el, x: e.clientX, y: e.clientY };
    },
    true,
  );
  addEventListener(
    'pointermove',
    (e) => {
      if (!editing) return;
      if (sizing) return;
      if (!drag) {
        const el = editableOf(e.target);
        if (el !== hovered) {
          hovered = el;
          layout();
        }
      }
      if (press && !drag && Math.hypot(e.clientX - press.x, e.clientY - press.y) > DRAG_SLOP) {
        drag = { el: press.el };
        if (sel !== press.el) select(press.el);
        hide(hoverBox);
      }
      if (!drag) return;
      block(e);
      const r = drag.el.getBoundingClientRect();
      const w = Math.min(r.width, 240);
      const h = Math.min(r.height, 120);
      put(ghost, { left: e.clientX + 8, top: e.clientY + 8, width: w, height: h });
      drag.drop = dropAt(e.clientX, e.clientY, drag.el);
      drawDrop(drag.drop, drag.el);
    },
    true,
  );
  addEventListener(
    'pointerup',
    (e) => {
      if (!editing) return;
      if (drag) {
        block(e);
        finishDrag();
      } else if (press) {
        block(e);
        select(press.el);
      }
      press = undefined;
    },
    true,
  );
  for (const type of ['mousedown', 'mouseup', 'click', 'auxclick', 'contextmenu']) {
    addEventListener(
      type,
      (e) => {
        if (editing && !inTyping(e.target) && editableOf(e.target)) block(e);
      },
      true,
    );
  }
  addEventListener(
    'dblclick',
    (e) => {
      if (!editing || inTyping(e.target)) return;
      const el = editableOf(e.target);
      if (!el) return;
      block(e);
      select(el);
      startTyping(el);
    },
    true,
  );
  addEventListener(
    'keydown',
    (e) => {
      if (!editing) return;
      if (typing) {
        if (e.key === 'Enter' && !e.shiftKey) {
          block(e);
          stopTyping(true);
        } else if (e.key === 'Escape') {
          block(e);
          stopTyping(false);
        } else e.stopImmediatePropagation();
        return;
      }
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'z') {
        block(e);
        post({ type: 'key', key: e.shiftKey ? 'redo' : 'undo' });
      } else if (mod && e.key.toLowerCase() === 'd' && sel) {
        block(e);
        act('duplicate');
      } else if ((e.key === 'Backspace' || e.key === 'Delete') && sel) {
        block(e);
        act('remove');
      } else if (e.key === 'Enter' && sel) {
        block(e);
        startTyping(sel);
      } else if (e.key === 'Escape' && sel) {
        block(e);
        select(undefined);
      }
    },
    true,
  );

  handle.addEventListener('pointerdown', (e) => {
    if (!(sel instanceof HTMLElement)) return;
    e.preventDefault();
    e.stopPropagation();
    handle.setPointerCapture(e.pointerId);
    const r = sel.getBoundingClientRect();
    sizing = { el: sel, x: e.clientX, y: e.clientY, w: r.width, h: r.height, scale: sel.offsetWidth ? r.width / sel.offsetWidth : 1 };
  });
  handle.addEventListener('pointermove', (e) => {
    if (!sizing) return;
    const { el, x, y, w, h, scale } = sizing;
    el.style.width = `${Math.max(4, Math.round((w + e.clientX - x) / scale))}px`;
    el.style.height = `${Math.max(4, Math.round((h + e.clientY - y) / scale))}px`;
    layout();
  });
  handle.addEventListener('pointerup', () => {
    if (!sizing) return;
    const { el } = sizing;
    sizing = undefined;
    saveStyle(el, { width: el.style.width, height: el.style.height });
  });

  // The page's own edits, such as an artboard frame dragged on a canvas.
  document.addEventListener(PAGE_EDIT_EVENT, (e) => {
    if (!editing) return;
    const detail = (e as CustomEvent<{ target?: unknown; set?: Record<string, string | null> }>).detail;
    const el = detail?.target;
    if (!(el instanceof Element) || !el.hasAttribute(AT_ATTR) || !detail.set) return;
    const set = detail.set;
    enqueue(() => ({ kind: 'attrs', at: atOf(el), set }));
  });

  // ── The pane's commands ────────────────────────────────────────────────

  function act(what: 'parent' | 'duplicate' | 'remove' | 'deselect'): void {
    const el = sel;
    if (what === 'deselect' || !el) {
      select(undefined);
      return;
    }
    if (what === 'parent') {
      const p = parentOf(el);
      if (p) select(p);
      return;
    }
    if (what === 'duplicate') {
      enqueue(() => {
        if (!el.isConnected) return undefined;
        el.after(el.cloneNode(true));
        follow = true;
        return { kind: 'duplicate', at: atOf(el) };
      });
      return;
    }
    select(undefined);
    enqueue(() => {
      if (!el.isConnected) return undefined;
      const at = atOf(el);
      el.remove();
      return { kind: 'remove', at };
    });
  }

  function insert(what: InsertKind): void {
    const el = sel;
    if (!el) return;
    const container = isContainer(el) ? el : parentOf(el);
    if (!container) return;
    const before = container === el ? null : (kids(container)[kids(container).indexOf(el) + 1] ?? null);
    enqueue(() => {
      if (!container.isConnected) return undefined;
      const tpl = document.createElement('template');
      tpl.innerHTML = INSERTS[what];
      const node = tpl.content.firstElementChild!;
      node.setAttribute(AT_ATTR, '-1');
      container.insertBefore(node, before);
      follow = true;
      return { kind: 'insert', parent: atOf(container), before: before ? atOf(before) : null, what };
    });
  }

  return {
    get editing() {
      return editing;
    },
    setEditing(on) {
      if (on === editing) return;
      if (!on) stopTyping(true);
      editing = on;
      if (on) {
        document.documentElement.setAttribute('data-agent-brief-editing', '');
        document.head.append(page);
      } else {
        document.documentElement.removeAttribute('data-agent-brief-editing');
        page.remove();
        hovered = undefined;
        press = undefined;
        drag = undefined;
        hide(hoverBox, selBox, intoBox, line, ghost, tag, handle);
        if (sel) select(undefined);
      }
    },
    onEdited,
    style: (set) => sel && saveStyle(sel, set),
    text: (text) => sel && saveText(sel, text),
    act,
    insert,
    layout,
  };
}
