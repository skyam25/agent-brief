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
