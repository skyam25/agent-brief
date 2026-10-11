/** Slots are `{{name}}` holes in a template that a draft fills in. */

export interface Slot {
  start: number;
  end: number;
  name: string;
}

const SLOT = /\{\{([^{}\n]{1,80})\}\}/g;

export function findSlots(text: string): Slot[] {
  return [...text.matchAll(SLOT)].map((m) => ({ start: m.index, end: m.index + m[0].length, name: m[1].trim() }));
}

/** The slot after `from`, or before it going back. Wraps around the text. */
export function nextSlot(text: string, from: number, back = false): Slot | undefined {
  const slots = findSlots(text);
  if (slots.length === 0) return undefined;
  if (back) return [...slots].reverse().find((s) => s.end < from) ?? slots[slots.length - 1];
  return slots.find((s) => s.start >= from) ?? slots[0];
}

/** A line that starts with `/` asks for a template; the rest of the line filters them. */
export function slashQuery(text: string, caret: number): { start: number; query: string } | undefined {
  const start = text.lastIndexOf('\n', caret - 1) + 1;
  const line = text.slice(start, caret);
  return line.startsWith('/') ? { start, query: line.slice(1) } : undefined;
}
