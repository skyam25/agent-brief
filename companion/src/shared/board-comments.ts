/** Comments pinned to a board's elements, and the comments.md a Send writes. */

/** A comment pinned to a spot on the board, usually on one element. */
export interface BoardPin {
  id: string;
  /** The element under the pin. Undefined for a pin on empty board. */
  elementId?: string;
  /** The pin's spot in scene coordinates, as it dropped. */
  x: number;
  y: number;
  /** The pin's spot inside its element, as fractions of the element's box, so the pin moves with it. */
  fx?: number;
  fy?: number;
  /** The element's kind, such as `rectangle` or `frame`. */
  type?: string;
  /** The words the element shows, cut short. */
  label?: string;
  /** The name of the frame holding the element. */
  frame?: string;
  text: string;
  createdAt: number;
}

export interface BoardComments {
  /** Words about the board as a whole. */
  overall: string;
  pins: BoardPin[];
}

export const MAX_PINS = 100;
const PIN_ID = /^[\w-]{1,40}$/;

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const clip = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.slice(0, max) : undefined);
const fraction = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : undefined);

/** True when the comments hold something to send. */
export const hasBoardComments = (c: BoardComments | undefined): c is BoardComments => !!c && (c.pins.length > 0 || !!c.overall.trim());

/** Checks comments from the renderer and keeps only their known fields. Undefined when there is nothing to send. */
export function cleanBoardComments(raw: unknown): BoardComments | undefined {
  if (!isRecord(raw)) return undefined;
  const pins: BoardPin[] = [];
  for (const p of Array.isArray(raw.pins) ? raw.pins.slice(0, MAX_PINS) : []) {
    if (!isRecord(p) || typeof p.id !== 'string' || !PIN_ID.test(p.id)) continue;
    const elementId = clip(p.elementId, 200);
    const type = clip(p.type, 40);
    const label = clip(p.label, 500);
    const frame = clip(p.frame, 300);
    const fx = fraction(p.fx);
    const fy = fraction(p.fy);
    pins.push({
      id: p.id,
      ...(elementId ? { elementId } : {}),
      x: num(p.x),
      y: num(p.y),
      ...(fx !== undefined && fy !== undefined ? { fx, fy } : {}),
      ...(type ? { type } : {}),
      ...(label ? { label } : {}),
      ...(frame ? { frame } : {}),
      text: typeof p.text === 'string' ? p.text.slice(0, 20_000) : '',
      createdAt: num(p.createdAt),
    });
  }
  const comments = { overall: typeof raw.overall === 'string' ? raw.overall.slice(0, 20_000) : '', pins };
  return hasBoardComments(comments) ? comments : undefined;
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** A pin's name in lists: its element and the words it shows, like `rectangle “Open the app”`. */
export function pinLabel(p: BoardPin, max = 60): string {
  const kind = p.type ?? (p.elementId ? 'element' : 'board');
  const words = oneLine(p.label ?? '');
  return words ? `${kind} “${cut(words, max)}”` : kind;
}

/** `3 comments`, `1 comment`. */
const commentCount = (n: number) => `${n} comment${n === 1 ? '' : 's'}`;

/** The comments.md a Send writes. Pin numbers match the violet badges on sketch.png. */
export function boardCommentsMarkdown(boardName: string, c: BoardComments): string {
  const lines = [
    `# Comments on the board "${boardName}"`,
    '',
    'Comments pinned to the board in Agent Brief. Each names its element by id, as `agent-brief read` lists it, and sketch.png shows each pin as a numbered violet badge.',
  ];
  const overall = c.overall.trim();
  if (overall) lines.push('', '## Overall', '', overall);
  c.pins.forEach((p, i) => {
    lines.push('', `## ${i + 1}. ${pinLabel(p)}`, '', p.text.trim() || '(No words. The pin marks this spot.)', '');
    if (p.elementId) lines.push(`- Element: \`${p.elementId}\``);
    if (p.frame) lines.push(`- In frame: “${cut(oneLine(p.frame), 120)}”`);
    if (p.label) lines.push(`- Element text: “${cut(oneLine(p.label), 200)}”`);
    lines.push(`- At: ${Math.round(p.x)},${Math.round(p.y)} on the board`);
  });
  return `${lines.join('\n')}\n`;
}

/** The prompt line after the `@comments.md` line. */
export function boardCommentsAsk(boardName: string, c: BoardComments): string {
  const n = c.pins.length;
  const what = n ? `${commentCount(n)} pinned to the board` : 'a note on the board';
  return `Feedback on the board "${boardName}" from Agent Brief, ${what}. Make the changes, on the board where they belong, then say what changed.`;
}
