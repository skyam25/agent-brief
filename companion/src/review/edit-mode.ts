/**
 * Edit mode for the page in the review pane. A click selects an element, a drag
 * moves it into another place or container, the corner handle resizes it, and a
 * double click retypes its words, keeping their bold, italics and links. A drag
 * from the pane's Add buttons drops new markup in. ⌘-click reaches the page, so
 * links and buttons still work. Each change shows at once and goes to the pane
 * as one edit, one at a time. Main's answer renumbers the page's `data-ab-at`
 * values so the next edit names elements as the file now has them.
 */

import { AT_ATTR, escapeAttr, escapeText, GROUND_ATTR, INLINE_TAGS, INSERTS, INSPECTOR_PROPS, PAGE_EDIT_EVENT, PASS_ATTR } from '../shared/review-edit';
import type { EditResult, InsertKind, ReviewEdit, SelectedElement, StyleSet } from '../shared/review-edit';
import type { FromPage } from './messages';
import { cut, oneLine } from '../shared/text';

const EDIT = '#2f7cf6';
/** The containers HTML lets these elements sit in. */
const HOLDERS: Record<string, readonly string[]> = {
  tr: ['table', 'thead', 'tbody', 'tfoot'],
  td: ['tr'],
  th: ['tr'],
  thead: ['table'],
  tbody: ['table'],
  tfoot: ['table'],
  caption: ['table'],
  li: ['ul', 'ol', 'menu'],
  option: ['select', 'optgroup', 'datalist'],
  optgroup: ['select'],
  summary: ['details'],
};
/** Containers that hold only the elements HOLDERS sends them. */
const STRICT = new Set(['table', 'thead', 'tbody', 'tfoot', 'tr', 'ul', 'ol', 'menu', 'select', 'optgroup', 'datalist']);
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
/** How far a press moves before it counts as a drag. */
const DRAG_SLOP = 4;
const SVG_NS = 'http://www.w3.org/2000/svg';

const tagOf = (el: Element) => el.tagName.toLowerCase();

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
  /** A drag from the pane's Add buttons, at a point in the page's viewport. */
  dragInsert(what: InsertKind, x: number, y: number, phase: 'move' | 'drop' | 'cancel'): void;
  /** Moves the boxes to their elements. The overlay calls it on scroll, resize and a timer. */
  layout(): void;
}

export function createEditMode(deps: { post: (m: FromPage) => void; root: ShadowRoot; host: () => HTMLElement | undefined; version?: string }): EditMode {
  const { post } = deps;
  let editing = false;
  let version = deps.version;
  let sel: Element | undefined;
  let hovered: Element | undefined;
  /** Where the pointer last was over the page. A scroll or pan moves the page under it. */
  let pointer: { x: number; y: number } | undefined;
  /** `before` is the raw markup Esc puts back. `clean` is the same words as the file holds them. */
  let typing: { el: Element; before: string; clean?: string; tags?: boolean } | undefined;
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
    html[data-agent-brief-editing] hr[${AT_ATTR}] { position: relative; overflow: visible; }

    /* A divider is a hairline, so its press area reaches a few pixels past it. */
    html[data-agent-brief-editing] hr[${AT_ATTR}]::after { content: ''; position: absolute; inset: -6px 0; }
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
    return el && !isGround(el) && el !== document.body ? el : undefined;
  }

  /** What `el` sits in for drops and adds. The body counts here, though it never takes a selection. */
  const holderOf = (el: Element): Element | undefined => {
    const p = el.parentElement?.closest(`[${AT_ATTR}]`);
    return p && !isGround(p) ? p : undefined;
  };
  const parentOf = (el: Element): Element | undefined => {
    const p = holderOf(el);
    return p === document.body ? undefined : p;
  };
  /** The editable children, looking through the table sections a browser adds around rows. */
  const kids = (el: Element, skip?: Element): Element[] =>
    [...el.children].flatMap((c) => (c.hasAttribute(AT_ATTR) ? (c === skip ? [] : [c]) : /^T(BODY|HEAD|FOOT)$/.test(c.tagName) ? kids(c, skip) : []));

  /** The words of an element: all of them for a text-only element, else its one direct run of text. */
  function wordsOf(el: Element): { text: string; node?: Text } | undefined {
    if (VOID.has(el.tagName.toLowerCase())) return undefined;
    if (el.children.length === 0) return { text: el.textContent ?? '' };
    const runs = [...el.childNodes].filter((n): n is Text => n.nodeType === Node.TEXT_NODE && !!oneLine(n.textContent ?? ''));
    return runs.length === 1 ? { text: oneLine(runs[0]!.textContent ?? ''), node: runs[0] } : undefined;
  }

  /** Whether the element holds only words and inline tags from the file, so typing can keep its bold, italics and links. */
  function isRich(el: Element): el is HTMLElement {
    if (!(el instanceof HTMLElement) || VOID.has(tagOf(el)) || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return false;
    const inline = (n: Node): boolean =>
      n.nodeType === Node.TEXT_NODE || n.nodeType === Node.COMMENT_NODE || (n instanceof HTMLElement && INLINE_TAGS.has(tagOf(n)) && n.hasAttribute(AT_ATTR) && [...n.childNodes].every(inline));
    return [...el.childNodes].every(inline);
  }

  /** Where typing goes: the paragraph a bold word or link sits in, else the element itself. */
  function typeTarget(el: Element): Element {
    let at = el;
    for (let p = parentOf(at); p && INLINE_TAGS.has(tagOf(at)) && isRich(p); p = parentOf(at)) at = p;
    return at;
  }

  /**
   * The typed element's insides as the file will hold them. Tags the browser added
   * keep only a link's address, and other tags give up their words.
   */
  function inlineHtml(el: Element, keepNbsp: boolean): string {
    const out = (n: Node): string => {
      if (n.nodeType === Node.TEXT_NODE) {
        const t = n.textContent ?? '';
        return escapeText(keepNbsp ? t : t.replace(/\u00a0/g, ' '));
      }
      if (!(n instanceof Element)) return '';
      const inner = [...n.childNodes].map(out).join('');
      const tag = tagOf(n);
      if (!INLINE_TAGS.has(tag)) return inner;
      const fromFile = n.hasAttribute(AT_ATTR);
      const attrs = [...n.attributes].filter((a) => a.name !== AT_ATTR && (fromFile || a.name === 'href'));
      if (!fromFile && tag === 'span' && !attrs.length) return inner;
      const open = `<${tag}${attrs.map((a) => ` ${a.name}="${escapeAttr(a.value)}"`).join('')}>`;
      return VOID.has(tag) ? open : `${open}${inner}</${tag}>`;
    };
    return [...el.childNodes].map(out).join('');
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
      canInsert: !!insertTarget(el),
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
    if (pointer && !drag && !sizing) hovered = editableOf(document.elementFromPoint(pointer.x, pointer.y));
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

    // A textarea someone typed in no longer shows its text, so its value changes too.
    if (el instanceof HTMLTextAreaElement) el.value = text;
    enqueue(() => ({ kind: 'text', at: atOf(el), text }));
  }

  // ── Typing in place ────────────────────────────────────────────────────

  function startTyping(from: Element): void {
    const el = typeTarget(from);
    if (sel !== el) select(el);

    // A textarea types into its value, and its words in the file are that value's start.
    if (el instanceof HTMLTextAreaElement) {
      typing = { el, before: el.value };
      el.focus();
      el.select();
    } else if (isRich(el)) {
      typing = { el, before: el.innerHTML, clean: inlineHtml(el, true), tags: el.children.length > 0 };
      el.setAttribute('contenteditable', 'true');
      el.focus();
      const range = document.createRange();
      range.selectNodeContents(el);
      getSelection()?.removeAllRanges();
      getSelection()?.addRange(range);
    } else return;
    el.addEventListener('blur', () => stopTyping(true), { once: true });
    layout();
  }

  function stopTyping(keep: boolean): void {
    if (!typing) return;
    const { el, before, clean, tags } = typing;
    typing = undefined;
    getSelection()?.removeAllRanges();
    if (el instanceof HTMLTextAreaElement) {
      el.blur();
      const text = el.value;
      if (!keep) el.value = before;
      else if (text !== before) enqueue(() => ({ kind: 'text', at: atOf(el), text }));
    } else {
      el.removeAttribute('contenteditable');
      const html = keep ? inlineHtml(el, clean!.includes('&nbsp;')) : clean;

      // The page shows the file's markup until the edit's turn, so its marks match main's answers.
      el.innerHTML = before;
      if (html !== clean) {
        enqueue(() => {
          if (!el.isConnected) return undefined;
          el.innerHTML = html!;
          el.querySelectorAll('*').forEach((k) => k.setAttribute(AT_ATTR, '-1'));
          return tags || el.children.length ? { kind: 'inline', at: atOf(el), html: html! } : { kind: 'text', at: atOf(el), text: el.textContent ?? '' };
        });
      }
    }
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

  /** Whether HTML lets `moving` sit directly in `container`, so a row stays in a table and an item in a list. */
  function fits(container: Element, moving: Element): boolean {
    const holders = HOLDERS[moving.tagName.toLowerCase()];
    const name = container.tagName.toLowerCase();
    return holders ? holders.includes(name) : !STRICT.has(name);
  }

  function dropAt(x: number, y: number, moving: Element): Drop | undefined {
    let target: Element | undefined;
    let ground = false;
    for (const hit of document.elementsFromPoint(x, y)) {
      if (hit.closest(`[${GROUND_ATTR}]`)) {
        ground = true;
        break;
      }
      const el = editableOf(hit);
      if (el && !moving.contains(el)) {
        target = el;
        break;
      }
    }

    // Bare page around the content drops into the body. A canvas's ground never takes drops.
    if (!target && !ground && document.body?.hasAttribute(AT_ATTR)) target = document.body;

    // Climbs from the element under the pointer until a container can hold what moves.
    for (; target; target = holderOf(target)) {
      const parent = holderOf(target);
      const r = target.getBoundingClientRect();
      const nearEdge = () => {
        if (!parent) return false;
        const axis = axisOf(parent);
        const [p, start, size] = axis === 'x' ? [x, r.left, r.width] : [y, r.top, r.height];
        const edge = Math.min(12, size / 4);
        return p - start < edge || start + size - p < edge;
      };
      if (isContainer(target) && fits(target, moving) && !nearEdge()) {
        const axis = axisOf(target);
        const p = axis === 'x' ? x : y;
        const before = kids(target, moving).find((k) => mid(k.getBoundingClientRect(), axis) > p) ?? null;
        return { container: target, before };
      }
      if (!parent || !fits(parent, moving)) continue;
      const axis = axisOf(parent);
      if ((axis === 'x' ? x : y) < mid(r, axis)) return { container: parent, before: target };
      const siblings = kids(parent, moving);
      return { container: parent, before: siblings[siblings.indexOf(target) + 1] ?? null };
    }
    return undefined;
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

      // A browser puts table rows in a tbody the file may not have, so the drop spot's own parent holds them.
      const holder = before?.parentElement ?? kids(container, el).at(-1)?.parentElement ?? container;
      holder.insertBefore(el, before);
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

  // Pasted words come in plain, so another page's markup never reaches the file.
  addEventListener(
    'paste',
    (e) => {
      if (!typing || typing.el instanceof HTMLTextAreaElement || !inTyping(e.target)) return;
      block(e);
      document.execCommand('insertText', false, e.clipboardData?.getData('text/plain') ?? '');
    },
    true,
  );

  // Window capture runs before any listener the page adds, so presses on editable elements never reach it.
  addEventListener(
    'pointerdown',
    (e) => {
      if (!editing || e.button !== 0 || inTyping(e.target) || e.metaKey) return;
      if (typing) stopTyping(true);
      const el = editableOf(e.target);
      if (!el) return;
      block(e);

      // Blocking the press also keeps focus out of the page, so Delete, ⌘D and Enter would miss it.
      if (!document.hasFocus()) window.focus();
      press = { el, x: e.clientX, y: e.clientY };
    },
    true,
  );
  document.documentElement.addEventListener('pointerleave', () => {
    pointer = hovered = undefined;
    layout();
  });
  addEventListener(
    'pointermove',
    (e) => {
      pointer = { x: e.clientX, y: e.clientY };
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
        // A drag inside the selection moves the selection, so a table row or a full container can move.
        const moving = sel && sel !== press.el && sel.contains(press.el) ? sel : press.el;
        drag = { el: moving };
        if (sel !== moving) select(moving);
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
        if (editing && !inTyping(e.target) && !(e as MouseEvent).metaKey && editableOf(e.target)) block(e);
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

  /** Where Add puts markup for `el`: inside it, or after it in its parent. Undefined when HTML forbids that spot. */
  function insertTarget(el: Element): Element | undefined {
    const container = isContainer(el) ? el : holderOf(el);
    return container && !STRICT.has(container.tagName.toLowerCase()) ? container : undefined;
  }

  const sample = (what: InsertKind) => {
    const tpl = document.createElement('template');
    tpl.innerHTML = INSERTS[what];
    return tpl.content.firstElementChild!;
  };

  function insert(what: InsertKind): void {
    const el = sel;
    if (!el) return;
    const container = insertTarget(el);
    if (!container) return;
    const before = container === el ? null : (kids(container)[kids(container).indexOf(el) + 1] ?? null);
    insertAt(what, container, before);
  }

  /** The drop a drag from the Add buttons would make now. */
  let adding: Drop | undefined;

  function dragInsert(what: InsertKind, x: number, y: number, phase: 'move' | 'drop' | 'cancel'): void {
    if (!editing) return;
    const inside = x >= 0 && y >= 0 && x <= innerWidth && y <= innerHeight;
    const node = sample(what);
    adding = phase !== 'cancel' && inside ? dropAt(x, y, node) : undefined;
    if (phase === 'move') {
      hide(hoverBox);
      if (inside) put(ghost, { left: x + 8, top: y + 8, width: 96, height: 24 });
      else hide(ghost);
      drawDrop(adding, node);
      return;
    }
    hide(intoBox, line, ghost);
    if (phase === 'drop' && adding) insertAt(what, adding.container, adding.before);
    adding = undefined;
  }

  function insertAt(what: InsertKind, container: Element, before: Element | null): void {
    enqueue(() => {
      if (!container.isConnected || (before && !before.isConnected)) return undefined;
      const node = sample(what);
      node.setAttribute(AT_ATTR, '-1');

      // Rows go in the tbody a browser added, as moves do.
      (before?.parentElement ?? container).insertBefore(node, before);
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
    dragInsert,
    layout,
  };
}
