/**
 * An item's workspace: one Sketch board per feedback item, named `fb-<output stem>-<n>`,
 * with one frame per round titled `Round N`. The board notes' first line binds it to
 * the item. Each Save exports a new `<output>.feedback/<n>-workspace-<k>.png` and
 * appends a `Workspace:` line naming it.
 */

import type { DrawRequest, ElementSummary, FeedbackItem, Skeleton } from '../protocol';

export const WORKSPACE_PREFIX = 'fb-';

/** Board names stop at 64 characters. */
const MAX_NAME = 64;

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

/** The output file and item a board's notes bind it to. Undefined for a board that is not a workspace. */
export function bindingOf(notes: string): { outputFile: string; n: number } | undefined {
  const m = /^Feedback workspace · (\/.+) #(\d+)$/.exec(notes.split('\n')[0]?.trim() ?? '');
  return m ? { outputFile: m[1]!, n: Number(m[2]) } : undefined;
}

export const boundTo = (notes: string, outputFile: string, n: number) => notes.split('\n')[0]?.trim() === workspaceBinding(outputFile, n);

/** Workspace boards stay out of the sidebar and the board picker. Only a binding marks one, never the name. */
export const isWorkspaceNotes = (notes: string) => bindingOf(notes) !== undefined;

/** The PNG one Save writes. Each save takes the next `k`, so older lines keep their pictures. */
export const workspacePng = (n: number, k: number) => `${n}-workspace-${k}.png`;

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

/** What the rail lists: notes, voice notes, and review and workspace pins, in file order. */
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
    else if ((verb === 'note' || verb === 'voice' || verb === 'pin') && detail) out.push({ kind: verb, date, text: detail });
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

const snapshotAt = (frame: { x: number; y: number }, snapshot: WorkspaceSnapshot): Skeleton => ({
  type: 'image',
  x: frame.x + INSET * 2 + STICKY.width,
  y: frame.y + INSET,
  ...fitSnapshot(snapshot),
  image: snapshot.data,
});

/**
 * What to draw so the board has every frame the item needs. Each round the item
 * came up in gets a frame with its quote sticky, placed right of the board. The
 * newest round's frame also gets the element's picture when it has none. Nothing
 * on the board is moved or replaced. Undefined when nothing is missing.
 */
export function seedRequest(
  item: FeedbackItem,
  board: { elements: Pick<ElementSummary, 'id' | 'type' | 'label' | 'frameId' | 'x' | 'y'>[]; bounds: { x: number; y: number; width: number; height: number } },
  snapshot?: WorkspaceSnapshot,
): DrawRequest | undefined {
  const newest = workspaceRound(item);
  const rounds = item.rounds.length ? item.rounds : [newest];
  const frameOf = (round: number) => board.elements.find((e) => e.type === 'frame' && e.label === frameTitle(round));
  const elements: Skeleton[] = [];
  const empty = board.elements.length === 0;
  let x = empty ? 0 : Math.round(board.bounds.x + board.bounds.width + FRAME_GAP);
  const y = empty ? 0 : Math.round(board.bounds.y);
  for (const round of rounds) {
    if (frameOf(round)) continue;
    const id = `frame-${round}`;
    elements.push(
      { id, type: 'frame', x, y, ...FRAME, label: frameTitle(round) },
      { id: `quote-${round}`, type: 'sticky', x: x + INSET, y: y + INSET, ...STICKY, label: stickyText(item, round), align: 'left', frameId: id },
    );
    if (snapshot && round === newest) elements.push({ ...snapshotAt({ x, y }, snapshot), id: 'snapshot', frameId: id });
    x += FRAME.width + FRAME_GAP;
  }
  // A frame made before a picture was at hand, as from the CLI, gets one now.
  const kept = frameOf(newest);
  if (snapshot && kept && !board.elements.some((e) => e.type === 'image' && e.frameId === kept.id)) {
    elements.push({ ...snapshotAt(kept, snapshot), id: 'snapshot', frameId: kept.id });
  }
  return elements.length ? { elements } : undefined;
}
