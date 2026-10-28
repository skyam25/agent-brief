/**
 * Source edits for the review pane. Serving marks each element in the body with
 * `data-ab-at`, its start tag's offset in the file. An edit names elements by
 * that offset and splices the file's text, so everything it does not touch keeps
 * its formatting.
 */

import { createHash } from 'node:crypto';
import { parse, parseFragment, type DefaultTreeAdapterMap } from 'parse5';
import { AT_ATTR, INLINE_TAGS, INSERTS, type ReviewEdit, type StyleSet } from '../shared/review-edit';

type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
/** Elements whose insides are not markup a person edits. */
const SKIP = new Set(['script', 'style', 'template', 'noscript']);

export class EditError extends Error {}

const isElement = (n: Node): n is Element => 'tagName' in n;

/** The nearest ancestor written in the file, past ones the parser adds, such as a table's tbody. */
function sourceParent(el: Element): Node | undefined {
  let p = el.parentNode as Node | null;
  while (p && isElement(p) && !p.sourceCodeLocation?.startTag) p = p.parentNode as Node | null;
  return p ?? undefined;
}
const startOf = (el: Element) => el.sourceCodeLocation!.startTag!.startOffset;

/** The body, when the file writes its tag, then the body's elements that come from the source, in document order. */
function editable(html: string): Element[] {
  const doc = parse(html, { sourceCodeLocationInfo: true });
  const htmlEl = doc.childNodes.find(isElement);
  const body = htmlEl?.childNodes.filter(isElement).find((n) => n.tagName === 'body');
  const out: Element[] = [];
  const walk = (node: Element) => {
    for (const child of node.childNodes) {
      if (!isElement(child) || SKIP.has(child.tagName)) continue;
      if (child.sourceCodeLocation?.startTag) out.push(child);
      walk(child);
    }
  };
  if (body?.sourceCodeLocation?.startTag) out.push(body);
  if (body) walk(body);
  return out;
}

/** Every editable element's offset, in document order, as the page's `data-ab-at` values run. */
export const editableOffsets = (html: string): number[] => editable(html).map(startOf);

/** The file with `data-ab-at` on each editable element's start tag. */
export function annotate(html: string): string {
  let out = html;
  for (const el of editable(html).reverse()) {
    if (el.attrs.some((a) => a.name === AT_ATTR)) continue;
    const at = startOf(el) + 1 + el.tagName.length;
    out = `${out.slice(0, at)} ${AT_ATTR}="${startOf(el)}"${out.slice(at)}`;
  }
  return out;
}

/** A short hash of the file, so an edit made against an older copy is refused. */
export const versionOf = (html: string) => createHash('sha1').update(html).digest('hex').slice(0, 16);

// ── Reading the source ───────────────────────────────────────────────────

const escapeText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\u00a0/g, '&nbsp;');
const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

function textOf(node: Node): string {
  if (node.nodeName === '#text') return (node as DefaultTreeAdapterMap['textNode']).value;
  if (!isElement(node) || SKIP.has(node.tagName)) return '';
  return node.childNodes.map(textOf).join(' ');
}

/** Whether the element holds only words and inline tags, so its insides can be replaced as a whole. */
function inlineOnly(el: Element): boolean {
  return el.childNodes.every((n) => n.nodeName === '#text' || n.nodeName === '#comment' || (isElement(n) && INLINE_TAGS.has(n.tagName) && !!n.sourceCodeLocation && inlineOnly(n)));
}

/**
 * Markup from a retyped element, cut down to words and inline tags. Other tags give up
 * their words, comments go, and event handlers and script links never pass.
 */
export function cleanInline(html: string): string {
  const out = (node: Node): string => {
    if (node.nodeName === '#text') return escapeText((node as DefaultTreeAdapterMap['textNode']).value);
    if (!isElement(node)) return '';
    const inner = node.childNodes.map(out).join('');
    if (SKIP.has(node.tagName)) return '';
    if (!INLINE_TAGS.has(node.tagName)) return inner;
    const attrs = node.attrs
      .filter((a) => a.name !== AT_ATTR && !a.name.startsWith('on') && !(a.name === 'href' && /^\s*(javascript|vbscript|data):/i.test(a.value)))
      .map((a) => ` ${a.name}="${escapeAttr(a.value)}"`)
      .join('');
    return VOID.has(node.tagName) ? `<${node.tagName}${attrs}>` : `<${node.tagName}${attrs}>${inner}</${node.tagName}>`;
  };
  return parseFragment(html).childNodes.map(out).join('');
}

/** The words of inline markup, run together as a reader sees them. */
const plainOf = (node: Node): string =>
  node.nodeName === '#text' ? (node as DefaultTreeAdapterMap['textNode']).value : isElement(node) ? node.childNodes.map(plainOf).join('') : '';

/** `button “Talk”`, the way summaries name an element. */
function label(el: Element): string {
  const words = oneLine(textOf(el));
  return words ? `${el.tagName} “${cut(words, 40)}”` : el.tagName;
}

/** The element's whole range in the source, or an error when its end tag is missing. */
function outer(html: string, el: Element): { start: number; end: number } {
  const loc = el.sourceCodeLocation!;
  const tag = loc.startTag!;
  const selfClosed = html.slice(tag.endOffset - 2, tag.endOffset) === '/>';
  if (!loc.endTag && !VOID.has(el.tagName) && !selfClosed) throw new EditError(`${label(el)} has no end tag in the file, so it can't be moved, copied or removed here`);
  return { start: loc.startOffset, end: loc.endOffset };
}

/** Where a line-start cut begins, and the indent, when `at` starts its own line. */
function lineOf(html: string, at: number): { from: number; indent: string; ownLine: boolean } {
  let i = at;
  while (i > 0 && (html[i - 1] === ' ' || html[i - 1] === '\t')) i--;
  const ownLine = i === 0 || html[i - 1] === '\n';
  return { from: ownLine && i > 0 ? i - 1 : at, indent: ownLine ? html.slice(i, at) : '', ownLine };
}

/** Shifts every line after the first by the change from `from` to `to`. */
function reindent(block: string, from: string, to: string): string {
  if (from === to) return block;
  return block
    .split('\n')
    .map((line, i) => (i === 0 ? line : line.startsWith(from) ? to + line.slice(from.length) : line))
    .join('\n');
}

/** Where markup goes to sit in `parent` before `before`, or last, and the text that puts it there. */
function placement(html: string, parent: Element, before: Element | undefined, block: string, blockIndent: string): { at: number; text: string; lead: number } {
  if (before) {
    const line = lineOf(html, startOf(before));
    if (line.ownLine) {
      const text = `${line.indent}${reindent(block, blockIndent, line.indent)}\n`;
      return { at: line.from + 1, text, lead: line.indent.length };
    }
    return { at: startOf(before), text: block, lead: 0 };
  }
  const endTag = parent.sourceCodeLocation?.endTag;
  if (!endTag) throw new EditError(`${label(parent)} has no end tag in the file, so nothing can go inside it`);
  const line = lineOf(html, endTag.startOffset);
  if (line.ownLine) {
    const siblings = parent.childNodes.filter(isElement).filter((c) => c.sourceCodeLocation);
    const last = siblings.at(-1);
    const indent = last ? lineOf(html, startOf(last)).indent || `${line.indent}  ` : `${line.indent}  `;
    const text = `${indent}${reindent(block, blockIndent, indent)}\n`;
    return { at: line.from + 1, text, lead: indent.length };
  }
  return { at: endTag.startOffset, text: block, lead: 0 };
}

// ── Inline styles and attributes ─────────────────────────────────────────

/** Splits a style attribute into declarations, keeping semicolons inside parentheses and quotes. */
export function parseStyle(style: string): [string, string][] {
  const out: [string, string][] = [];
  let depth = 0;
  let quote = '';
  let part = '';
  const flush = () => {
    const i = part.indexOf(':');
    if (i > 0) out.push([part.slice(0, i).trim().toLowerCase(), part.slice(i + 1).trim()]);
    part = '';
  };
  for (const ch of style) {
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (ch === ';' && depth === 0) {
      flush();
      continue;
    }
    part += ch;
  }
  flush();
  return out;
}

export function mergeStyle(style: string, set: StyleSet): string {
  const decls = parseStyle(style);
  for (const [prop, value] of Object.entries(set)) {
    const i = decls.findIndex(([p]) => p === prop);
    const clean = value?.trim().replace(/;+$/, '');
    if (!clean) {
      if (i >= 0) decls.splice(i, 1);
    } else if (i >= 0) decls[i] = [prop, clean];
    else decls.push([prop, clean]);
  }
  return decls.map(([p, v]) => `${p}: ${v}`).join('; ');
}

/** The start tag with `name` set to `value`, or dropped when it is null. */
function setAttr(html: string, el: Element, name: string, value: string | null): string {
  const loc = el.sourceCodeLocation!;
  const range = loc.attrs?.[name];
  if (range) {
    if (value === null) {
      let from = range.startOffset;
      while (from > 0 && /\s/.test(html[from - 1]!)) from--;
      return html.slice(0, from) + html.slice(range.endOffset);
    }
    return `${html.slice(0, range.startOffset)}${name}="${escapeAttr(value)}"${html.slice(range.endOffset)}`;
  }
  if (value === null) return html;
  const tagEnd = loc.startTag!.endOffset;
  let at = tagEnd - 1;
  if (html[at - 1] === '/') at--;
  while (at > startOf(el) + 1 && /\s/.test(html[at - 1]!)) at--;
  return `${html.slice(0, at)} ${name}="${escapeAttr(value)}"${html.slice(at)}`;
}

const attrOf = (el: Element, name: string) => el.attrs.find((a) => a.name === name)?.value;

const describeSet = (set: Record<string, string | null>, sep: string, fmt: (k: string, v: string) => string) =>
  Object.entries(set)
    .map(([k, v]) => (v === null || !v.trim() ? `removed ${k}` : fmt(k, v)))
    .join(sep);

// ── Edits ────────────────────────────────────────────────────────────────

export interface Applied {
  html: string;
  /** The edited or new element's offset in the new file. */
  at?: number;
  summary: string;
}

/** Applies one edit to the file's text. Throws EditError when the edit does not fit the file. */
export function applyEdit(html: string, edit: ReviewEdit): Applied {
  const elements = editable(html);
  const byAt = (at: number, what = 'element') => {
    const el = elements.find((e) => startOf(e) === at);
    if (!el) throw new EditError(`The ${what} is not in the file any more. Reload the page.`);
    return el;
  };

  // The body holds what goes in and out of it, but never changes itself.
  const own = (at: number) => {
    const el = byAt(at);
    if (el.tagName === 'body') throw new EditError('The page body holds elements, but cannot change itself here');
    return el;
  };
  const childOf = (parent: Element, at: number | null) => {
    if (at === null) return undefined;
    const el = byAt(at, 'drop spot');
    if (sourceParent(el) !== parent) throw new EditError('The drop spot is not inside that container');
    return el;
  };

  switch (edit.kind) {
    case 'text': {
      const el = own(edit.at);
      const loc = el.sourceCodeLocation!;
      const kids = el.childNodes.filter((n) => isElement(n) || oneLine((n as { value?: string }).value ?? ''));
      const before = label(el);
      if (kids.every((n) => !isElement(n)) && loc.endTag) {
        const next = html.slice(0, loc.startTag!.endOffset) + escapeText(edit.text) + html.slice(loc.endTag.startOffset);
        return { html: next, at: edit.at, summary: `Changed the text of ${before} to “${cut(oneLine(edit.text), 80)}”` };
      }
      const words = kids.filter((n) => n.nodeName === '#text');
      const node = words.length === 1 ? words[0]! : undefined;
      const range = node?.sourceCodeLocation;
      if (!range) throw new EditError(`${before} mixes words and elements, so its text cannot change here`);
      const raw = html.slice(range.startOffset, range.endOffset);
      const lead = /^\s*/.exec(raw)![0];
      const trail = /\s*$/.exec(raw)![0];
      const next = `${html.slice(0, range.startOffset)}${lead}${escapeText(edit.text)}${trail}${html.slice(range.endOffset)}`;
      return { html: next, at: edit.at, summary: `Changed the text of ${before} to “${cut(oneLine(edit.text), 80)}”` };
    }
    case 'inline': {
      const el = own(edit.at);
      const loc = el.sourceCodeLocation!;
      const before = label(el);
      if (!loc.endTag) throw new EditError(`${before} has no end tag in the file, so its text cannot change here`);
      if (!inlineOnly(el)) throw new EditError(`${before} holds more than words and inline tags, so its text cannot change here`);
      const inner = cleanInline(edit.html);
      const words = oneLine(parseFragment(inner).childNodes.map(plainOf).join(''));
      const next = html.slice(0, loc.startTag!.endOffset) + inner + html.slice(loc.endTag.startOffset);
      return { html: next, at: edit.at, summary: `Changed the text of ${before} to “${cut(words, 80)}”` };
    }
    case 'style': {
      const el = own(edit.at);
      const style = mergeStyle(attrOf(el, 'style') ?? '', edit.set);
      const next = setAttr(html, el, 'style', style || null);
      return { html: next, at: edit.at, summary: `Set ${describeSet(edit.set, '; ', (k, v) => `${k}: ${v}`)} on ${label(el)}` };
    }
    case 'attrs': {
      const el = own(edit.at);
      // Later attributes first, so earlier ranges stay put.
      const names = Object.keys(edit.set).sort((a, b) => (el.sourceCodeLocation!.attrs?.[b]?.startOffset ?? -1) - (el.sourceCodeLocation!.attrs?.[a]?.startOffset ?? -1));
      let next = html;
      for (const name of names) {
        const fresh = editable(next).find((e) => startOf(e) === edit.at)!;
        next = setAttr(next, fresh, name, edit.set[name]!);
      }
      return { html: next, at: edit.at, summary: `Set ${describeSet(edit.set, ', ', (k, v) => `${k}="${v}"`)} on ${label(el)}` };
    }
    case 'remove': {
      const el = own(edit.at);
      const { start, end } = outer(html, el);
      const from = lineOf(html, start).from;
      return { html: html.slice(0, from) + html.slice(end), summary: `Removed ${label(el)}` };
    }
    case 'duplicate': {
      const el = own(edit.at);
      const { start, end } = outer(html, el);
      const line = lineOf(html, start);
      const block = html.slice(start, end);
      const text = line.ownLine ? `\n${line.indent}${block}` : block;
      const at = end + (line.ownLine ? 1 + line.indent.length : 0);
      return { html: html.slice(0, end) + text + html.slice(end), at, summary: `Duplicated ${label(el)}` };
    }
    case 'insert': {
      const parent = byAt(edit.parent, 'container');
      const before = childOf(parent, edit.before);
      const place = placement(html, parent, before, INSERTS[edit.what], '');
      const next = html.slice(0, place.at) + place.text + html.slice(place.at);
      return { html: next, at: place.at + place.lead, summary: `Added ${edit.what} to ${label(parent)}` };
    }
    case 'move': {
      const el = own(edit.at);
      const parent = byAt(edit.parent, 'container');
      const before = childOf(parent, edit.before);
      if (before === el) return { html, at: edit.at, summary: `Left ${label(el)} where it was` };
      for (let p: Node | null = parent; p; p = (p as Element).parentNode ?? null) {
        if (p === el) throw new EditError(`${label(el)} cannot move inside itself`);
      }
      const { start, end } = outer(html, el);
      const line = lineOf(html, start);
      const cutFrom = line.from;
      const place = placement(html, parent, before, html.slice(start, end), line.indent);
      if (place.at > cutFrom && place.at < end) throw new EditError(`${label(el)} cannot move inside itself`);
      const where = label(parent);
      let next: string;
      let at: number;
      if (place.at >= end) {
        next = html.slice(0, cutFrom) + html.slice(end, place.at) + place.text + html.slice(place.at);
        at = place.at - (end - cutFrom) + place.lead;
      } else {
        next = html.slice(0, place.at) + place.text + html.slice(place.at, cutFrom) + html.slice(end);
        at = place.at + place.lead;
      }
      const spot = before ? `before ${label(before)}` : 'at the end';
      return { html: next, at, summary: `Moved ${label(el)} into ${where}, ${spot}` };
    }
  }
}
