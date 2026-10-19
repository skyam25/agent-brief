/**
 * Sizes for comment pins on an exported PNG, and the legend strip under it that
 * lists each pin's words. Sizes are in output pixels.
 */

/** A text's width in pixels at a font size. */
export type Measure = (text: string, px: number) => number;

/** Pin badge size: at least 28 px, and about 1/64 of the long edge. */
export const pinSize = (width: number, height: number) => Math.max(28, Math.round(Math.max(width, height) / 64));

/** The legend is never narrower than this, so a small crop still reads. */
const MIN_WIDTH = 480;

/** Lines per pin before the words are cut. */
const MAX_LINES = 3;

/** Breaks `text` into lines no wider than `max`, at most `cap` of them, the last ending in … when cut. */
export function wrapWords(text: string, max: number, measure: (s: string) => number, cap = Infinity): string[] {
  const lines: string[] = [];
  let line = '';
  const push = (s: string) => {
    lines.push(s);
    return lines.length < cap;
  };
  const words = text.split(/\s+/).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    let word = words[i]!;
    const joined = line ? `${line} ${word}` : word;
    if (measure(joined) <= max) {
      line = joined;
      continue;
    }
    if (line && !push(line)) return cut(lines, words.slice(i), max, measure);
    line = '';

    // A word wider than the line breaks wherever it must.
    while (measure(word) > max) {
      let n = word.length - 1;
      while (n > 1 && measure(word.slice(0, n)) > max) n--;
      if (!push(word.slice(0, n))) return cut(lines, [word.slice(n), ...words.slice(i + 1)], max, measure);
      word = word.slice(n);
    }
    line = word;
  }
  if (line) lines.push(line);
  return lines;
}

/** Ends the last line with … to show `rest` was left out. */
function cut(lines: string[], rest: string[], max: number, measure: (s: string) => number): string[] {
  if (!rest.some(Boolean)) return lines;
  let last = lines.pop()!;
  while (last && measure(`${last.trimEnd()}…`) > max) last = last.slice(0, -1);
  return [...lines, `${last.trimEnd()}…`];
}

export interface LegendRow {
  /** The pin's number, from 1. */
  n: number;
  /** Top of the row, from the top of the strip. */
  top: number;
  lines: string[];
}

export interface LegendLayout {
  unit: number;
  font: number;
  lineHeight: number;
  pad: number;
  /** Left edge of each row's words. Badges sit at `pad`. */
  textX: number;
  width: number;
  height: number;
  rows: LegendRow[];
}

/**
 * Lays out a strip for a `width` × `height` picture with one row per worded pin,
 * numbered by its place in `texts`. Undefined when no pin has words.
 */
export function legendLayout(texts: readonly string[], width: number, height: number, measure: Measure): LegendLayout | undefined {
  const unit = pinSize(width, height);
  const font = Math.round(unit * 0.6);
  const lineHeight = Math.round(font * 1.4);
  const pad = Math.round(unit * 0.75);
  const textX = pad + unit + Math.round(unit * 0.5);
  const stripWidth = Math.max(width, MIN_WIDTH);
  const fit = (s: string) => measure(s, font);
  const rows: LegendRow[] = [];
  let y = pad;
  texts.forEach((text, i) => {
    const lines = wrapWords(text, stripWidth - textX - pad, fit, MAX_LINES);
    if (!lines.length) return;
    rows.push({ n: i + 1, top: y, lines });
    y += Math.max(unit, lines.length * lineHeight) + Math.round(pad / 2);
  });
  if (!rows.length) return undefined;
  return { unit, font, lineHeight, pad, textX, width: stripWidth, height: y - Math.round(pad / 2) + pad, rows };
}
