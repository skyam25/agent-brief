/** How an initiative brief splits into `## ` sections, shared by the parser, the validator and the panel. */

export const HEADING = /^##[ \t]+(.+?)[ \t#]*$/;
export const FENCE = /^\s*(```|~~~)/;

/**
 * Why `text` cannot sit inside one section, or undefined when it can.
 * A `## ` line outside a code fence starts a new section, and an open fence hides the headings after it.
 */
export function sectionBreak(text: string): string | undefined {
  let fenced = false;
  for (const line of text.split(/\r?\n/)) {
    if (FENCE.test(line)) fenced = !fenced;
    else if (!fenced && HEADING.test(line)) return `"${line.trim()}" would start a new section of the brief. Use ### or plain text instead.`;
  }
  return fenced ? 'A code fence is never closed, which would hide the sections after it.' : undefined;
}

/** A Markdown link in a brief line. */
export interface BriefLink {
  /** The link text, unescaped. */
  label: string;
  /** A `file:` link's path, else the destination as written. */
  target: string;
  /** `file` for a `file:` link, `url` for http or https, `other` for anything else. */
  kind: 'file' | 'url' | 'other';
  /** Where the link's Markdown starts and ends in the line. */
  start: number;
  end: number;
}

const LINK = /\[((?:\\.|[^\]\\])*)\]\((?:<([^>]*)>|([^)\s]+))\)/g;

/** The `[label](<dest>)` and `[label](dest)` links in a line, in order. */
export function briefLinks(text: string): BriefLink[] {
  return [...text.matchAll(LINK)].map((m) => {
    const dest = (m[2] ?? m[3] ?? '').trim();
    const file = /^file:(?:\/\/)?/i.exec(dest);
    const kind = file ? 'file' : /^https?:\/\//i.test(dest) ? 'url' : 'other';
    return { label: m[1]!.replace(/\\(.)/g, '$1'), target: file ? dest.slice(file[0].length) : dest, kind, start: m.index!, end: m.index! + m[0].length };
  });
}
