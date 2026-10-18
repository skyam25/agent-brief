/**
 * An item's workspace: one Sketch board per feedback item, named `fb-<output stem>-<n>`,
 * with one frame per round titled `Round N`. Save exports the board to
 * `<output>.feedback/<n>-workspace.png` and appends a `Workspace:` line.
 */

import type { DrawRequest, ElementSummary, FeedbackItem, Skeleton } from '../protocol';

export const WORKSPACE_PREFIX = 'fb-';

/** Board names stop at 64 characters. */
const MAX_NAME = 64;

/** Workspace boards stay out of the sidebar and the board picker. */
export const isWorkspaceBoard = (name: string) => name.startsWith(WORKSPACE_PREFIX);

/** The output's file name without its last extension, safe for a board name. */
export function outputStem(output: string): string {
  const base = output.split(/[\\/]/).at(-1) ?? '';
  const stem = base.includes('.') && !base.startsWith('.') ? base.slice(0, base.lastIndexOf('.')) : base;
  return stem.replace(/[^\w.-]+/gu, '-').replace(/-{2,}/g, '-').replace(/^[-.]+|[-.]+$/g, '') || 'output';
}

/** `fb-<stem>-<n>`, then `-2`, `-3` for a name another output already holds. */
export function workspaceBoardName(output: string, n: number, attempt = 1): string {
  const tail = `-${n}${attempt > 1 ? `-${attempt}` : ''}`;
  return `${WORKSPACE_PREFIX}${outputStem(output).slice(0, MAX_NAME - WORKSPACE_PREFIX.length - tail.length)}${tail}`;
}

/** The board notes' first line ties the board to one item of one output file. */
export const workspaceBinding = (outputFile: string, n: number) => `Feedback workspace · ${outputFile} #${n}`;

export const boundTo = (notes: string, outputFile: string, n: number) => notes.split('\n')[0]?.trim() === workspaceBinding(outputFile, n);

/** `saved · <board> · <png>` on a `Workspace:` line. */
export const workspaceLine = (board: string, png: string) => `saved · ${board} · ${png}`;

export interface SavedWorkspace {
  date: string;
  board: string;
  png?: string;
}

/** The item's latest saved workspace, from its `Workspace:` lines. */
export function latestWorkspace(item: Pick<FeedbackItem, 'events'>): SavedWorkspace | undefined {
  const last = item.events.filter((e) => e.key === 'Workspace' && e.verb === 'saved').at(-1);
  if (!last) return undefined;
  const [board = '', png] = last.detail.split(' · ').map((s) => s.trim());
  return board ? { date: last.date, board, ...(png ? { png } : {}) } : undefined;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `2026-10-18` as `Oct 18`. */
export function shortDate(iso: string): string {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(iso);
  const month = m ? MONTHS[Number(m[1]) - 1] : undefined;
  return m && month ? `${month} ${Number(m[2])}` : iso;
}

/** The item card's one line, such as `Workspace · saved Oct 18`. */
export function workspaceSummary(item: Pick<FeedbackItem, 'events'>): string | undefined {
  const saved = latestWorkspace(item);
  return saved && `Workspace · saved ${shortDate(saved.date)}`;
}

/** The newest round the item came up in. Each round gets its own frame. */
export const workspaceRound = (item: Pick<FeedbackItem, 'rounds' | 'round'>) => item.rounds.at(-1) ?? item.round ?? 1;

export const frameTitle = (round: number) => `Round ${round}`;

/** What the rail lists: notes, voice notes and review pins, in file order. */
export interface RailEntry {
  kind: 'note' | 'voice' | 'pin';
  date: string;
  text: string;
}

export function railEntries(item: Pick<FeedbackItem, 'lines'>): RailEntry[] {
  const out: RailEntry[] = [];
  for (const line of item.lines) {
    if (!line.key) {
      out.push({ kind: 'note', date: '', text: line.text });
      continue;
    }
    if (line.key !== 'You' && line.key !== 'Review') continue;
    const [date = '', verb = '', ...rest] = line.text.split(' · ').map((s) => s.trim());
    const detail = rest.join(' · ');
    if (line.key === 'Review') out.push({ kind: 'pin', date, text: [verb, detail].filter(Boolean).join(' · ') });
    else if ((verb === 'note' || verb === 'voice') && detail) out.push({ kind: verb, date, text: detail });
  }
  return out;
}

/** The quote the workspace leads with: the newest round's, else the first. */
export function workspaceQuote(item: Pick<FeedbackItem, 'sources'>, round: number): FeedbackItem['sources'][number] | undefined {
  return item.sources.filter((s) => s.round === round).at(-1) ?? item.sources[0];
}

/** A picture of the item's element, as a data URL with its size in CSS pixels. */
export interface WorkspaceSnapshot {
  data: string;
  width: number;
  height: number;
}

const FRAME = { width: 1100, height: 720 };
const FRAME_GAP = 160;
const INSET = 48;
const STICKY = { width: 320, height: 220 };
const SNAPSHOT_BOX = { width: FRAME.width - STICKY.width - INSET * 3, height: FRAME.height - INSET * 2 };

/** Fits a picture inside the frame beside the sticky, never larger than it is. */
export function fitSnapshot(s: Pick<WorkspaceSnapshot, 'width' | 'height'>): { width: number; height: number } {
  const scale = Math.min(1, SNAPSHOT_BOX.width / s.width, SNAPSHOT_BOX.height / s.height);
  return { width: Math.max(1, Math.round(s.width * scale)), height: Math.max(1, Math.round(s.height * scale)) };
}

const stickyText = (item: FeedbackItem, round: number) => {
  const src = workspaceQuote(item, round);
  const quote = src?.quote ? `"${src.quote}"${src.speaker ? ` — ${src.speaker}` : ''}` : item.title;
  return item.change ? `${quote}\n\nChange: ${item.change}` : quote;
};

/**
 * What to draw so the board has a frame for the item's newest round: the frame,
 * a sticky with the quote and the proposed change, and the element's picture when
 * there is one. Undefined when the frame is already there. New frames go right of the board.
 */
export function seedRequest(
  item: FeedbackItem,
  board: { elements: Pick<ElementSummary, 'type' | 'label'>[]; bounds: { x: number; y: number; width: number; height: number } },
  snapshot?: WorkspaceSnapshot,
): DrawRequest | undefined {
  const round = workspaceRound(item);
  const title = frameTitle(round);
  if (board.elements.some((e) => e.type === 'frame' && e.label === title)) return undefined;
  const empty = board.elements.length === 0;
  const x = empty ? 0 : Math.round(board.bounds.x + board.bounds.width + FRAME_GAP);
  const y = empty ? 0 : Math.round(board.bounds.y);
  const elements: Skeleton[] = [
    { id: 'frame', type: 'frame', x, y, ...FRAME, label: title },
    { id: 'quote', type: 'sticky', x: x + INSET, y: y + INSET, ...STICKY, label: stickyText(item, round), align: 'left', frameId: 'frame' },
  ];
  if (snapshot) {
    elements.push({ id: 'snapshot', type: 'image', x: x + INSET * 2 + STICKY.width, y: y + INSET, ...fitSnapshot(snapshot), image: snapshot.data, frameId: 'frame' });
  }
  return { elements };
}
