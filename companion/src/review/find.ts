/**
 * Find on the page under review. Matches show through the CSS Custom Highlight API,
 * so the page's DOM never changes and edit mode never saves a highlight to the file.
 */

const ALL = 'agent-brief-find';
const CURRENT = 'agent-brief-find-current';

/** Text in these never counts. The overlay's own elements sit in `agent-brief-overlay`. */
const SKIP = 'script, style, noscript, template, select, agent-brief-overlay';

/** Text under one of these is one run, so a match can cross inline marks but not blocks. */
const BLOCK = 'p, li, dt, dd, h1, h2, h3, h4, h5, h6, td, th, caption, figcaption, blockquote, pre, summary, button, div, section, article, aside, header, footer, main, nav, body';

export interface Found {
  total: number;
  current: number;
}

export interface PageFind {
  /** Highlights every match of `query`. An empty query clears them. */
  find(query: string): Found;
  step(dir: 1 | -1): Found;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

interface Run {
  text: string;
  nodes: { node: Text; start: number }[];
}

/** The page's visible text, in runs that each stay inside one block. */
function runs(): Run[] {
  const out: Run[] = [];
  const shown = new Map<Element, boolean>();
  const visible = (el: Element) => {
    let v = shown.get(el);
    if (v === undefined) shown.set(el, (v = !el.closest(SKIP) && el.checkVisibility({ visibilityProperty: true })));
    return v;
  };
  let run: Run | undefined;
  let block: Element | null = null;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const parent = node.parentElement;
    if (!parent || !node.data || !visible(parent)) continue;
    const here = parent.closest(BLOCK);
    if (!run || here !== block) {
      run = { text: '', nodes: [] };
      block = here;
      out.push(run);
    }
    run.nodes.push({ node, start: run.text.length });
    run.text += node.data;
  }
  return out;
}

/** The text node and offset at `index` in a run. */
function at(run: Run, index: number, end: boolean): [Text, number] {
  let i = run.nodes.length - 1;
  while (i > 0 && (end ? run.nodes[i]!.start >= index : run.nodes[i]!.start > index)) i--;
  const { node, start } = run.nodes[i]!;
  return [node, index - start];
}

function search(query: string): Range[] {
  if (!query.trim()) return [];
  // A space in the query matches any run of white space, as the page shows it collapsed.
  const pattern = new RegExp(escape(query.trim()).replace(/\s+/g, '\\s+'), 'gi');
  const out: Range[] = [];
  for (const run of runs()) {
    for (const m of run.text.matchAll(pattern)) {
      const range = document.createRange();
      range.setStart(...at(run, m.index, false));
      range.setEnd(...at(run, m.index + m[0].length, true));
      out.push(range);
    }
  }
  return out;
}

/** Scrolls a match into view. Inner scrollers move the least distance, then the page centres it if it is still off screen. */
function reveal(range: Range): void {
  range.startContainer.parentElement?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
  const box = range.getBoundingClientRect();
  if (box.top < 0 || box.bottom > innerHeight) scrollBy({ top: box.top - innerHeight / 2, behavior: 'instant' });
}

export function createFind(): PageFind {
  let query = '';
  let ranges: Range[] = [];
  let current = -1;

  const style = document.createElement('style');
  style.textContent = `
    ::highlight(${ALL}) { background-color: rgb(105 101 219 / 0.3); }
    ::highlight(${CURRENT}) { background-color: #6965db; color: #fff; }`;

  const paint = (): Found => {
    if (!ranges.length) {
      CSS.highlights.delete(ALL);
      CSS.highlights.delete(CURRENT);
      style.remove();
      return { total: 0, current: -1 };
    }
    if (!style.isConnected) document.head.append(style);
    CSS.highlights.set(ALL, new Highlight(...ranges));
    const focus = new Highlight(ranges[current]!);
    focus.priority = 1;
    CSS.highlights.set(CURRENT, focus);
    reveal(ranges[current]!);
    return { total: ranges.length, current };
  };

  return {
    find(next) {
      query = next;
      ranges = search(query);
      const top = ranges.findIndex((r) => r.getBoundingClientRect().bottom >= 0);
      current = ranges.length ? Math.max(0, top) : -1;
      return paint();
    },
    step(dir) {
      // The page may have changed since the last search, so this looks again and keeps the place.
      ranges = search(query);
      if (!ranges.length) return paint();
      current = (Math.min(current, ranges.length - 1) + dir + ranges.length) % ranges.length;
      return paint();
    },
  };
}
