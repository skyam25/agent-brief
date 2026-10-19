// Generated from companion/src/shared/feedback.ts. Run pnpm sync:plugin in companion; do not edit.
/**
 * Feedback items for one output, kept beside it in `<output>.feedback.md`.
 *
 *   # Feedback · checkout.html
 *
 *   ## Round 2 · SME · 2026-10-18 · transcripts/sme-2.md
 *   ## Round 1 · customers · 2026-10-12 · transcripts/cust-1.md
 *
 *   - [ ] #6 Hard to find the filters
 *       Round: 1
 *       Src: 1 · Ana · 03:02 · "Where do I filter?"
 *       Change: Move the filter row above the results.
 *       Option: A · Keep the sort on the right
 *       Where: #filters
 *       Claude: 2026-10-12 · cataloged
 *       You: 2026-10-12 · accept · keep it sticky on scroll
 *
 * Round lines are a registry, newest first. Items follow, in the order they came in.
 * Lines indented under an item belong to it. The file is add-only: writers append
 * lines, add items and rounds, or flip a checkbox, and leave every other byte as it was.
 */

import type { FeedbackDoc, FeedbackDocument, FeedbackEvent, FeedbackFileSummary, FeedbackItem, FeedbackLine, FeedbackOp, FeedbackRound, FeedbackSource, FeedbackState } from '../companion-protocol';

export const feedbackPath = (output: string) => `${output}.feedback.md`;

/** The sibling folder for an output's pictures and exports. */
export const feedbackAssets = (output: string) => `${output}.feedback`;

export const FEEDBACK_SUFFIX = '.feedback.md';

/** Dated lines. Their text is `<date> · <verb> · <detail>`. */
export const EVENT_KEYS = ['Claude', 'You', 'Workspace', 'Review'] as const;
export const FEEDBACK_KEYS = ['Round', 'Src', 'Change', 'Option', 'Where', 'Related', ...EVENT_KEYS, 'Before', 'After'] as const;

/** What the user can say on an item. `sent` marks the decisions Send handed over. */
export const YOU_VERBS = ['accept', 'reject', 'reopen', 'note', 'voice', 'sent'] as const;

/** Verbs that set an item's state. */
const STATE_VERBS: Record<string, FeedbackState> = {
  cataloged: 'open',
  reopen: 'open',
  accept: 'accepted',
  reject: 'rejected',
  rejected: 'rejected',
  done: 'done',
};

/** `Option: B · Hide the box`. */
const OPTION = /^([A-Za-z])\s*·\s*(.+)$/;
/** An accept's detail that picks an option: `option B · note`. */
const PICK = /^option ([A-Za-z])\b/i;

export type FeedbackActor = 'Claude' | 'You';

const ITEM = /^- \[( |x|X)\] #(\d+)\s*(.*)$/;
const ROUND = /^## Round (\d+)\s*·\s*(.*)$/;
const KEYED = /^([A-Za-z]+):\s?(.*)$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SEP = ' · ';
const INDENT = '    ';
const MAX_TEXT = 4000;
const MAX_OPS = 200;

const isEventKey = (key: string) => (EVENT_KEYS as readonly string[]).includes(key);
const isKnownKey = (key: string) => (FEEDBACK_KEYS as readonly string[]).includes(key);

/** Today in local time, as the file writes dates. */
export function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function parseEvent(key: string, text: string): FeedbackEvent {
  const parts = text.split(SEP).map((s) => s.trim());
  const date = DATE.test(parts[0] ?? '') ? parts.shift()! : '';
  return { key, date, verb: parts.shift() ?? '', detail: parts.join(SEP) };
}

/** The quote runs from the first `"` after the time to the last one. A legacy `\"` reads as `"`. */
export function parseSource(text: string): FeedbackSource | undefined {
  const [round, speaker = '', time = '', ...rest] = text.split(SEP).map((s) => s.trim());
  if (!/^\d+$/.test(round ?? '')) return undefined;
  const said = rest.join(SEP);
  const open = said.indexOf('"');
  const close = said.lastIndexOf('"');
  const quote = open >= 0 && close > open ? said.slice(open + 1, close) : said;
  return { round: Number(round), speaker, time, quote: quote.replace(/\\"/g, '"') };
}

const sourceLine = (s: FeedbackSource) => [s.round, s.speaker, s.time, `"${s.quote}"`].join(SEP);

/** The round a new round would repeat: one with the same source, or with the same label when neither has a source. */
export function findRound(rounds: FeedbackRound[], label: string, source?: string): FeedbackRound | undefined {
  return rounds.find((r) => (source ? r.source === source : !r.source && r.label === label));
}

/** Where each part of the document sits, by line index. */
interface Layout {
  title?: number;
  rounds: number[];
  items: { n: number; head: number; last: number; indent: string }[];
}

const isClosed = (state: FeedbackState) => state === 'done' || state === 'rejected';

function stateOf(item: Pick<FeedbackItem, 'events' | 'checked'>): FeedbackState {
  let state: FeedbackState | undefined;
  for (const e of item.events) {
    if (e.key !== 'Claude' && e.key !== 'You') continue;
    // `closed` comes from the close op and keeps a rejection.
    if (e.verb === 'closed') state = state === 'rejected' ? state : 'done';
    else if (STATE_VERBS[e.verb]) state = STATE_VERBS[e.verb];
  }
  return state ?? (item.checked ? 'done' : 'open');
}

/** The option the standing accept picked. A later state verb other than done drops it. */
function chosenOf(events: FeedbackEvent[]): string | undefined {
  let chosen: string | undefined;
  for (const e of events) {
    if (e.key !== 'You' && e.key !== 'Claude') continue;
    if (e.key === 'You' && e.verb === 'accept') chosen = PICK.exec(e.detail)?.[1]!.toUpperCase();
    else if (STATE_VERBS[e.verb] && STATE_VERBS[e.verb] !== 'done') chosen = undefined;
  }
  return chosen;
}

/** The newest round of a `Src:` line after the closing event of a closed item. */
function raisedAgainOf(item: FeedbackItem): number | undefined {
  if (!isClosed(item.state)) return undefined;
  let closedAt = -1;
  item.lines.forEach((l, i) => {
    if (!isEventKey(l.key)) return;
    const verb = parseEvent(l.key, l.text).verb;
    if (verb === 'closed' || (STATE_VERBS[verb] && isClosed(STATE_VERBS[verb]))) closedAt = i;
  });
  if (closedAt < 0) return undefined;
  const later = item.lines.slice(closedAt + 1).filter((l) => l.key === 'Src').map((l) => parseSource(l.text)?.round ?? 0);
  return later.length ? Math.max(...later) : undefined;
}

/** The proposal now differs from the one the last accept approved: its change or an option's text. */
function revisedSinceAccept(item: FeedbackItem): boolean {
  let change: string | undefined;
  const options = new Map<string, string>();
  const proposal = () => JSON.stringify([change, [...options].sort()]);
  let approved: string | undefined;
  for (const l of item.lines) {
    if (l.key === 'Change') change = l.text;
    else if (l.key === 'Option') {
      const m = OPTION.exec(l.text);
      if (m) options.set(m[1]!.toUpperCase(), m[2]!.trim());
    } else if (l.key === 'You' && parseEvent(l.key, l.text).verb === 'accept') approved = proposal();
  }
  return approved !== undefined && approved !== proposal();
}

function finish(item: FeedbackItem): FeedbackItem {
  item.state = stateOf(item);
  // An accept approves the proposal as it stood, so a later revision asks again.
  const revised = item.state === 'accepted' && revisedSinceAccept(item);
  if (revised) {
    item.state = 'open';
    item.revised = true;
  }
  item.rounds = [...new Set([...(item.round !== undefined ? [item.round] : []), ...item.sources.map((s) => s.round)])].sort((a, b) => a - b);
  const chosen = revised ? undefined : chosenOf(item.events);
  if (chosen) item.chosen = chosen;
  const raised = raisedAgainOf(item);
  if (raised) item.raisedAgain = raised;
  return item;
}

function parseLines(lines: string[]): { doc: FeedbackDoc; layout: Layout } {
  const doc: FeedbackDoc = { title: '', rounds: [], items: [] };
  const layout: Layout = { rounds: [], items: [] };
  let current: FeedbackItem | undefined;
  lines.forEach((raw, i) => {
    const line = raw.replace(/\r$/, '');
    const head = ITEM.exec(line);
    if (head) {
      current = { n: Number(head[2]), title: head[3]!.trim(), checked: head[1] !== ' ', state: 'open', rounds: [], sources: [], related: [], before: [], after: [], events: [], notes: [], lines: [] };
      doc.items.push(current);
      layout.items.push({ n: current.n, head: i, last: i, indent: INDENT });
      return;
    }
    if (line.trim() === '') return;
    if (/^\s/.test(line) && current) {
      const at = layout.items.at(-1)!;
      at.last = i;
      at.indent = /^\s+/.exec(line)![0];
      const body = line.trim();
      const keyed = KEYED.exec(body);
      const key = keyed && isKnownKey(keyed[1]!) ? keyed[1]! : '';
      const text = key ? keyed![2]!.trim() : body;
      current.lines.push({ key, text });
      if (!key) current.notes.push(text);
      else if (key === 'Round' && /^\d+$/.test(text) && current.round === undefined) current.round = Number(text);
      else if (key === 'Src') {
        const src = parseSource(text);
        if (src) current.sources.push(src);
      } else if (key === 'Change') current.change = text;
      else if (key === 'Option') {
        const m = OPTION.exec(text);
        if (m) {
          const option = { key: m[1]!.toUpperCase(), text: m[2]!.trim() };
          const options = (current.options ??= []);
          const at = options.findIndex((o) => o.key === option.key);
          if (at >= 0) options[at] = option;
          else options.push(option);
        }
      }
      else if (key === 'Where') current.where = text;
      else if (key === 'Related') {
        const m = /^(.+?)\s+#(\d+)$/.exec(text);
        if (m) current.related.push({ path: m[1]!, n: Number(m[2]) });
      } else if (key === 'Before') current.before.push(text);
      else if (key === 'After') current.after.push(text);
      else if (isEventKey(key)) current.events.push(parseEvent(key, text));
      return;
    }
    current = undefined;
    const round = ROUND.exec(line);
    if (round && doc.items.length === 0) {
      const [label = '', date = '', ...source] = round[2]!.split(SEP).map((s) => s.trim());
      doc.rounds.push({ n: Number(round[1]), label, date, ...(source.length ? { source: source.join(SEP) } : {}) });
      layout.rounds.push(i);
      return;
    }
    if (!doc.title && doc.items.length === 0 && line.startsWith('# ')) {
      doc.title = line.slice(2).trim();
      layout.title = i;
    }
  });
  doc.items.forEach(finish);
  return { doc, layout };
}

export function parseFeedback(text: string): FeedbackDoc {
  return parseLines(text.split('\n')).doc;
}

const roundLine = (r: FeedbackRound) => `## Round ${r.n}${SEP}${[r.label, r.date, ...(r.source ? [r.source] : [])].join(SEP)}`;
const itemLines = (item: FeedbackItem) => [`- [${item.checked ? 'x' : ' '}] #${item.n} ${item.title}`, ...item.lines.map((l) => `${INDENT}${l.key ? `${l.key}: ` : ''}${l.text}`)];

/** The canonical text for a document. Parsing it gives the document back. */
export function serializeFeedback(doc: FeedbackDoc): string {
  const out = [`# ${doc.title}`];
  if (doc.rounds.length) out.push('', ...doc.rounds.map(roundLine));
  for (const item of doc.items) out.push('', ...itemLines(item));
  return out.join('\n') + '\n';
}

const ESCAPES: Record<string, string> = { '\n': '\\n', '\r': '\\r', '\t': '\\t' };

/** Control characters as visible escapes, so a name stays on its one line. */
const escapeControls = (s: string) => s.replace(/[\u0000-\u001f\u007f]/g, (c) => ESCAPES[c] ?? `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

export class FeedbackOpError extends Error {}
const fail = (message: string): never => { throw new FeedbackOpError(message); };

function oneLine(v: unknown, what: string, max = MAX_TEXT): string {
  if (typeof v !== 'string' || !v.trim()) return fail(`${what} is empty`);
  if (/[\r\n]/.test(v)) return fail(`${what} must be one line`);
  if (v.length > max) return fail(`${what} is over ${max} characters`);
  return v.trim();
}

/** Checks one line's key and text for an actor, and gives the text as the file writes it. */
function lineText(doc: FeedbackDoc, key: unknown, text: unknown, by: FeedbackActor, date: string, item?: FeedbackItem): FeedbackLine {
  if (typeof key !== 'string' || !isKnownKey(key) || key === 'Round') return fail(`Unknown key ${String(key)}. Use ${FEEDBACK_KEYS.filter((k) => k !== 'Round').join(', ')}`);
  if (key === 'You' && by !== 'You') return fail('Only the user writes You lines');
  if (key === 'Claude' && by !== 'Claude') return fail('Only Claude writes Claude lines');
  const body = oneLine(text, `${key} text`);
  if (key === 'Src') {
    const src = parseSource(body);
    if (!src) return fail('Src is <round> · <speaker> · <time> · "<quote>", with the quote as said');
    if (!doc.rounds.some((r) => r.n === src.round)) return fail(`There is no round ${src.round}`);
    return { key, text: sourceLine(src) };
  }
  if (key === 'Option') {
    const m = OPTION.exec(body) ?? fail('Option is "<letter> · <text>", such as "A · Keep the box"');
    return { key, text: `${m[1]!.toUpperCase()}${SEP}${m[2]!.trim()}` };
  }
  if (key === 'Related' && !/^.+\s+#\d+$/.test(body)) return fail('Related is "<output path> #N"');
  if (!isEventKey(key)) return { key, text: body };
  const first = body.split(SEP)[0]!.trim();
  if (DATE.test(first)) return fail('Leave the date out; it is added for you');
  if (key === 'You' && !(YOU_VERBS as readonly string[]).includes(first)) return fail(`You lines start with ${YOU_VERBS.join(', ')}`);
  const pick = key === 'You' && first === 'accept' ? PICK.exec(parseEvent(key, body).detail)?.[1]!.toUpperCase() : undefined;
  if (pick && item && !item.options?.some((o) => o.key === pick)) return fail(`#${item.n} has no option ${pick}`);
  return { key, text: `${date}${SEP}${body}` };
}

/**
 * Applies ops to the file's text, or to a new file when `text` is undefined, and
 * keeps every existing byte as it was, trailing blank lines and CRLF endings included.
 * Throws FeedbackOpError on the first bad op, so a failed update changes nothing.
 */
export function applyFeedbackOps(
  text: string | undefined,
  opts: { output: string; ops: unknown; by: FeedbackActor; date: string; projectRounds?: FeedbackRound[] },
): { text: string; added: { rounds: number[]; items: number[] } } {
  const { ops, by, date } = opts;
  if (!Array.isArray(ops) || ops.length === 0) return fail('Expected ops');
  if (ops.length > MAX_OPS) return fail(`At most ${MAX_OPS} ops at once`);
  const name = escapeControls(opts.output.split('/').filter(Boolean).at(-1) ?? opts.output);
  const source = text ?? `# Feedback · ${name}\n`;
  const lines = source.split('\n');
  // Additions go above the trailing blank lines, and take the file's line ending.
  const tail: string[] = [];
  while (lines.length && /^\r?$/.test(lines.at(-1)!)) tail.unshift(lines.pop()!);
  const cr = source[source.indexOf('\n') - 1] === '\r' ? '\r' : '';
  const put = (...added: string[]) => added.map((l) => l + cr);
  const added = { rounds: [] as number[], items: [] as number[] };
  const mirror = new Set<number>();

  for (const raw of ops as FeedbackOp[]) {
    const { doc, layout } = parseLines(lines);
    const find = (n: unknown) => {
      const at = Number.isInteger(n) ? layout.items.find((i) => i.n === n) : undefined;
      return at ?? fail(`There is no item #${String(n)}`);
    };
    const flip = (n: unknown, checked: boolean) => {
      const at = find(n);
      lines[at.head] = lines[at.head]!.replace(/^- \[( |x|X)\]/, checked ? '- [x]' : '- [ ]');
    };
    if (!raw || typeof raw !== 'object') return fail('Each op is an object');
    if (raw.op === 'addRound') {
      const label = oneLine(raw.label, 'Round label', 200);
      const source = raw.source === undefined ? undefined : oneLine(raw.source, 'Round source', 1000);
      if (label.includes('·') || source?.includes('·')) return fail('Round label and source cannot hold ·');
      if (raw.date !== undefined && (typeof raw.date !== 'string' || !DATE.test(raw.date))) return fail('Round date is YYYY-MM-DD');
      const same = findRound(doc.rounds, label, source);
      if (same) {
        added.rounds.push(same.n);
        continue;
      }
      // Numbers are project-wide: a source keeps its number in every file, and a new one goes after the highest.
      const project = opts.projectRounds ?? [];
      const shared = source ? findRound(project, label, source)?.n : undefined;
      const n = shared !== undefined && !doc.rounds.some((r) => r.n === shared) ? shared : Math.max(0, ...project.map((r) => r.n), ...doc.rounds.map((r) => r.n)) + 1;
      const line = roundLine({ n, label, date: raw.date ?? date, ...(source ? { source } : {}) });
      // Round lines stay newest first.
      const below = layout.rounds.find((at, k) => doc.rounds[k]!.n < n);
      if (below !== undefined) lines.splice(below, 0, ...put(line));
      else if (layout.rounds.length) lines.splice(Math.max(...layout.rounds) + 1, 0, ...put(line));
      else {
        // The first round goes under the title, which a hand-made file may lack.
        if (layout.title === undefined) lines.unshift(...put(`# Feedback · ${name}`));
        const at = (layout.title ?? 0) + 1;
        const after = lines[at] !== undefined && lines[at]!.trim() !== '' ? [''] : [];
        lines.splice(at, 0, ...put('', line, ...after));
      }
      added.rounds.push(n);
    } else if (raw.op === 'addItem') {
      const title = oneLine(raw.title, 'Item title', 300);
      if (!doc.rounds.length) return fail('Add a round first');
      const round = raw.round ?? Math.max(...doc.rounds.map((r) => r.n));
      if (!doc.rounds.some((r) => r.n === round)) return fail(`There is no round ${String(round)}`);
      if (raw.lines !== undefined && !Array.isArray(raw.lines)) return fail('Item lines are a list');
      const body = (raw.lines ?? []).map((l) => lineText(doc, l?.key, l?.text, by, date));
      const n = Math.max(0, ...doc.items.map((i) => i.n)) + 1;
      const item = { n, title, checked: false, lines: [{ key: 'Round', text: String(round) }, ...body, { key: by, text: `${date}${SEP}${by === 'You' ? 'note · added' : 'cataloged'}` }] } as FeedbackItem;
      lines.push(...put('', ...itemLines(item)));
      added.items.push(n);
    } else if (raw.op === 'append') {
      const at = find(raw.item);
      const line = lineText(doc, raw.key, raw.text, by, date, doc.items.find((i) => i.n === at.n));
      lines.splice(at.last + 1, 0, ...put(`${at.indent}${line.key}: ${line.text}`));
      if (isEventKey(line.key) && STATE_VERBS[parseEvent(line.key, line.text).verb]) mirror.add(at.n);
    } else if (raw.op === 'close' || raw.op === 'open') {
      // Each op dates the state change it makes, so the checkbox and the history agree.
      const at = find(raw.item);
      const close = raw.op === 'close';
      if (isClosed(doc.items.find((i) => i.n === at.n)!.state) !== close) lines.splice(at.last + 1, 0, ...put(`${at.indent}${by}: ${date}${SEP}${close ? 'closed' : 'reopen'}`));
      flip(at.n, close);
    } else return fail(`Unknown op ${String((raw as { op?: unknown }).op)}`);
  }

  // A state verb moves the checkbox with it.
  if (mirror.size) {
    const { doc, layout } = parseLines(lines);
    for (const n of mirror) {
      const item = doc.items.find((i) => i.n === n)!;
      const head = layout.items.find((i) => i.n === n)!.head;
      if (isClosed(item.state) !== item.checked) lines[head] = lines[head]!.replace(/^- \[( |x|X)\]/, isClosed(item.state) ? '- [x]' : '- [ ]');
    }
  }
  return { text: [...lines, ...tail].join('\n'), added };
}

/** Counts for the project list. */
export function feedbackSummary(path: string, output: string, outputExists: boolean, doc: FeedbackDoc): FeedbackFileSummary {
  const count = (s: FeedbackState) => doc.items.filter((i) => i.state === s).length;
  return { path, output, outputExists, title: doc.title, rounds: doc.rounds.length, items: doc.items.length, open: count('open'), accepted: count('accepted'), rejected: count('rejected'), done: count('done') };
}

export interface PendingDecision {
  item: FeedbackItem;
  /** Your lines since the last send. */
  said: FeedbackEvent[];
  /** Workspaces saved since the last send. */
  saved: FeedbackEvent[];
  /** The 1-based index, among the item's events, of the last one this send covers. */
  through: number;
}

/** `sent · through 7` covers an item's first 7 events. */
const THROUGH = /^through (\d+)$/;

/**
 * Your lines and saved workspaces on each item that no receipt covers, for Send decisions.
 * A receipt without `through` covers the events before it.
 */
export function pendingDecisions(doc: FeedbackDoc): PendingDecision[] {
  const out: PendingDecision[] = [];
  for (const item of doc.items) {
    let covered = 0;
    item.events.forEach((e, i) => {
      if (e.key !== 'You' || e.verb !== 'sent') return;
      const through = THROUGH.exec(e.detail);
      covered = Math.max(covered, through ? Number(through[1]) : i);
    });
    const next: PendingDecision = { item, said: [], saved: [], through: 0 };
    item.events.forEach((e, i) => {
      if (i < covered) return;
      if (e.key === 'You' && e.verb !== 'sent') next.said.push(e);
      else if (e.key === 'Workspace' && e.verb === 'saved') next.saved.push(e);
      else return;
      next.through = i + 1;
    });
    if (next.through) out.push(next);
  }
  return out;
}

/** The receipts for what a send covered, in updates the store accepts. */
export function receiptBatches(pending: PendingDecision[]): FeedbackOp[][] {
  const ops: FeedbackOp[] = pending.map((p) => ({ op: 'append', item: p.item.n, key: 'You', text: `sent${SEP}through ${p.through}` }));
  const batches: FeedbackOp[][] = [];
  for (let i = 0; i < ops.length; i += MAX_OPS) batches.push(ops.slice(i, i + MAX_OPS));
  return batches;
}

/** A saved workspace's board and picture, the picture relative to the project. */
function savedWorkspace(output: string, e: FeedbackEvent): { board: string; picture?: string } {
  const [board = '', picture] = e.detail.split(SEP).map((s) => s.trim());
  const dir = output.includes('/') ? output.slice(0, output.lastIndexOf('/') + 1) : '';
  return { board, ...(picture ? { picture: `${dir}${picture}` } : {}) };
}

/** `option B · note` with the option's text, so Claude reads what was picked. */
function withOption(item: FeedbackItem, detail: string): string {
  const m = /^option (\S+)(.*)$/s.exec(detail);
  const option = m && item.options?.find((o) => o.key === m[1]);
  return option ? `option ${option.key} (${option.text})${m![2]}` : detail;
}

/** The message Send decisions hands Claude. */
export function decisionsPrompt(doc: Pick<FeedbackDocument, 'path' | 'output'>, pending: PendingDecision[]): string {
  const lines = [
    `@${doc.path}`,
    `Feedback decisions on ${doc.output} from Agent Brief, ${pending.length === 1 ? '1 item' : `${pending.length} items`}:`,
  ];
  for (const { item, said, saved } of pending) {
    const text = (e: FeedbackEvent) => [e.verb, withOption(item, e.detail)].filter(Boolean).join(SEP);
    // The last decision stands. Earlier ones go along as replaced, so their reasons aren't lost.
    const decisions = said.filter((e) => STATE_VERBS[e.verb]);
    const notes = said.filter((e) => !STATE_VERBS[e.verb]).map(text);
    // A revised item's accept approved an older proposal, so it goes along only as history.
    const last = item.revised ? undefined : decisions.at(-1);
    const head = item.revised ? ['not approved · the proposal changed after the accept, so build nothing until the user accepts it again'] : last ? [text(last)] : [];
    const words = [...head, ...notes].join('; ');
    const replaced = (item.revised ? decisions : decisions.slice(0, -1)).map(text).filter((t) => !last || t !== text(last));
    lines.push(`- #${item.n} ${item.title}: ${words || 'saved a workspace'}${replaced.length ? ` (replaces ${replaced.join('; ')})` : ''}`);
    if (last?.verb === 'accept' && item.change && !item.chosen) lines.push(`  Accepted change: ${item.change}`);
    for (const e of saved) {
      const w = savedWorkspace(doc.output, e);
      lines.push(`  Saved workspace: board ${w.board}${w.picture ? `, picture ${w.picture}` : ''}`);
    }
  }
  lines.push('Act on each item\'s standing decision: make the accepted changes and log them with agent-brief feedback done, leave rejected items alone, and answer notes with a Claude line. A note on an accept can narrow it. The feedback-items skill has the format.');
  if (pending.some((p) => p.saved.length)) lines.push("A saved workspace is the user's answer drawn out. Look at each saved workspace's picture and run agent-brief read --board <board> before you act on its item.");
  return lines.join('\n');
}

const STOP = new Set('the and for with that this from are was were but not you your have has can its into than then there their they them what when where which who will would should could about just like also very more some only over under after before again too out our'.split(' '));

/** A quote in curly marks. Straight quotes inside it become single ones, so `"Continue" to what?` shows as “‘Continue’ to what?”. */
export function quoted(text: string): string {
  return `“${text.replace(/"([^"]*)"/g, '‘$1’')}”`;
}

/** Words worth matching in an item, lower case. */
export function itemWords(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length > 2 && !STOP.has(w)).map((w) => w.replace(/s$/, '')));
}

export const feedbackItemText = (item: Pick<FeedbackItem, 'title' | 'change' | 'sources'>) => [item.title, item.change ?? '', ...item.sources.map((s) => s.quote)].join(' ');

/** Items across documents that share at least two words with `query`, most shared first. */
export function relatedCandidates(
  docs: Pick<FeedbackDocument, 'output' | 'items'>[],
  query: string,
  skip?: { output: string; n: number },
  limit = 5,
): { output: string; item: FeedbackItem; shared: string[] }[] {
  const want = itemWords(query);
  const hits: { output: string; item: FeedbackItem; shared: string[] }[] = [];
  for (const doc of docs) {
    for (const item of doc.items) {
      if (skip && doc.output === skip.output && item.n === skip.n) continue;
      const shared = [...itemWords(feedbackItemText(item))].filter((w) => want.has(w));
      if (shared.length >= 2) hits.push({ output: doc.output, item, shared });
    }
  }
  return hits.sort((a, b) => b.shared.length - a.shared.length).slice(0, limit);
}
