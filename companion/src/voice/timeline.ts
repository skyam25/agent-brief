/** Turns stroke events and utterances into the timeline an agent reads. */

import type { StrokeEvent, Utterance } from './types';

type Box = StrokeEvent['bbox'];

export interface TimelineInput {
  strokes: StrokeEvent[];
  utterances: Utterance[];
  /** The board's bounding box, for position words. */
  bounds: Box;
  /** Images on the board, such as pasted screenshots. Strokes over one are placed relative to it. */
  images?: Box[];
  boardName?: string;
}

export interface Timeline {
  timelineMd: string;
  /** The utterances in time order, ready for `transcript.json`. */
  transcript: Utterance[];
  /** All speech joined and trimmed. */
  speech: string;
  /** User stroke numbers by element id, in draw order from 1. */
  strokeNumbers: Record<string, number>;
  /** Letters for the pasted images still on the board, A first, by element id. */
  imageLetters: Record<string, string>;
}

const GROUP_GAP_MS = 600;
const LONG_UTTERANCE_MS = 12_000;
const MAX_LONG_REFS = 6;
const ANCHOR_BEFORE_MS = 1500;
const SPEECH_MAX_CHARS = 400;
/** An erase undone this soon leaves the board as it was. */
const RESTORE_MS = 5000;
/** A freehand mark smaller than this on both sides is a stray tap. */
const TAP_PX = 4;
/** Speech further than this from every stroke names none. */
const NEAREST_MAX_MS = 60_000;
/** Utterances closer together than this read as one line. */
const SPEECH_JOIN_MS = 1500;
/** Erases closer together than this share one line. */
const ERASE_JOIN_MS = 300;

// ── Words ─────────────────────────────────────────────────────────────────

/** Names a box's centre by thirds of the bounds. */
export function positionWords(box: Box, bounds: Box): string {
  const third = (centre: number, start: number, size: number) => {
    if (size <= 0) return 1;
    const r = (centre - start) / size;
    return r < 1 / 3 ? 0 : r < 2 / 3 ? 1 : 2;
  };
  const col = third(box.x + box.width / 2, bounds.x, bounds.width);
  const row = third(box.y + box.height / 2, bounds.y, bounds.height);
  if (row === 1 && col === 1) return 'centre';
  const v = ['top', '', 'bottom'][row];
  const h = ['left', '', 'right'][col];
  return [v, h].filter(Boolean).join(' ');
}

export function sizeWords(box: Box, bounds: Box): string {
  const wr = bounds.width > 0 ? box.width / bounds.width : 0;
  const hr = bounds.height > 0 ? box.height / bounds.height : 0;
  const r = Math.max(wr, hr);
  return r < 0.1 ? 'small' : r < 0.4 ? 'medium' : 'large';
}

const typeWord = (type: StrokeEvent['type']) => (type === 'freedraw' ? 'freehand' : type);

const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

/** `[00:06]`, or `[00:06–00:08]` when the span crosses a second. */
function stamp(t: number, tEnd: number): string {
  return clock(t) === clock(tEnd) ? `[${clock(t)}]` : `[${clock(t)}–${clock(tEnd)}]`;
}

export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const quote = (text: string) => `"${text.replace(/"/g, "'")}"`;

function union(boxes: Box[]): Box {
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  const right = Math.max(...boxes.map((b) => b.x + b.width));
  const bottom = Math.max(...boxes.map((b) => b.y + b.height));
  return { x, y, width: right - x, height: bottom - y };
}

function overlaps(a: Box, b: Box): boolean {
  return a.x <= b.x + b.width && b.x <= a.x + a.width && a.y <= b.y + b.height && b.y <= a.y + a.height;
}

function overlapArea(a: Box, b: Box): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

export interface PlacedImage {
  box: Box;
  /** Its letter on the PNG, when it has one. */
  letter?: string;
}

/** Where a box sits on the image it overlaps most, or undefined when it overlaps none. */
export function imageWords(box: Box, images: PlacedImage[]): string | undefined {
  let best: PlacedImage | undefined;
  let bestArea = 0;
  for (const img of images) {
    const area = overlapArea(box, img.box);
    if (area > bestArea) [best, bestArea] = [img, area];
  }
  if (!best) return undefined;
  const b = best.box;
  const name = best.letter ? `image ${best.letter}` : 'the image';
  const words = positionWords(box, b);
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const inside = cx >= b.x && cx <= b.x + b.width && cy >= b.y && cy <= b.y + b.height;
  if (inside) return `on ${name}, ${words}`;
  return `at ${name}'s ${words} ${words.includes(' ') ? 'corner' : 'edge'}`;
}

/** A, B, … Z, then A2, B2 and so on. */
const letterFor = (i: number) => String.fromCharCode(65 + (i % 26)) + (i >= 26 ? String(Math.floor(i / 26) + 1) : '');

/** Joins utterances less than 1.5 s apart, as one sentence spoken with pauses. */
export function joinSpeech(utterances: Utterance[]): Utterance[] {
  const out: Utterance[] = [];
  for (const u of utterances) {
    const prev = out[out.length - 1];
    if (prev && u.t - prev.tEnd < SPEECH_JOIN_MS) {
      out[out.length - 1] = { ...prev, tEnd: Math.max(prev.tEnd, u.tEnd), text: `${prev.text} ${u.text}` };
    } else {
      out.push({ ...u });
    }
  }
  return out;
}

// ── Cleanup ───────────────────────────────────────────────────────────────

/**
 * Leaves out what does not change the drawing: an erase and the add that
 * restores it within 5 s, and stray freehand taps.
 */
export function meaningful(strokes: StrokeEvent[]): StrokeEvent[] {
  const taps = new Set(
    strokes
      .filter((s) => s.kind === 'add' && s.type === 'freedraw' && s.bbox.width < TAP_PX && s.bbox.height < TAP_PX)
      .map((s) => s.elementId),
  );
  const byTime = strokes.map((s, i) => ({ s, i })).sort((a, b) => a.s.t - b.s.t || a.i - b.i);
  const dropped = new Set<StrokeEvent>();
  for (const { s: erase } of byTime) {
    if (erase.kind !== 'erase' || dropped.has(erase)) continue;
    const restore = byTime.find(
      ({ s }) =>
        s.kind === 'add' &&
        s.elementId === erase.elementId &&
        s.t >= erase.t &&
        s.t - erase.t <= RESTORE_MS &&
        !dropped.has(s),
    );
    if (!restore) continue;
    dropped.add(erase);
    dropped.add(restore.s);
  }
  return strokes.filter((s) => !dropped.has(s) && !taps.has(s.elementId));
}

// ── Strokes ───────────────────────────────────────────────────────────────

interface Group {
  strokes: StrokeEvent[];
  t: number;
  tEnd: number;
  /** Set when an utterance line names this group. */
  named: boolean;
}

/** Numbers user additions other than images in draw order. Ties keep the input order. */
function numberStrokes(strokes: StrokeEvent[]): { adds: StrokeEvent[]; numbers: Record<string, number> } {
  const adds = strokes
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => s.by === 'user' && s.kind === 'add' && s.type !== 'image')
    .sort((a, b) => a.s.t - b.s.t || a.i - b.i)
    .map(({ s }) => s);
  const numbers: Record<string, number> = {};
  for (const s of adds) if (!(s.elementId in numbers)) numbers[s.elementId] = Object.keys(numbers).length + 1;
  return { adds, numbers };
}

/** Joins consecutive strokes less than 600 ms apart whose boxes overlap. */
function group(adds: StrokeEvent[]): Group[] {
  const groups: Group[] = [];
  for (const s of adds) {
    const last = groups[groups.length - 1];
    const prev = last?.strokes[last.strokes.length - 1];
    if (last && prev && s.t - prev.tEnd < GROUP_GAP_MS && overlaps(prev.bbox, s.bbox)) {
      last.strokes.push(s);
      last.tEnd = Math.max(last.tEnd, s.tEnd);
    } else {
      groups.push({ strokes: [s], t: s.t, tEnd: s.tEnd, named: false });
    }
  }
  return groups;
}

/** Something speech can point at: a stroke group or a pasted image still on the board. */
interface Mark {
  label: string;
  t: number;
  tEnd: number;
  isImage: boolean;
}

/** The mark closest in time to an utterance, within a minute, with how far off it is. */
function nearest(u: Utterance, marks: Mark[]): string | undefined {
  let best: { gap: number; text: string } | undefined;
  for (const m of marks) {
    const during = m.t <= u.tEnd && m.tEnd >= u.t;
    const before = m.tEnd < u.t ? u.t - m.tEnd : undefined;
    const after = m.t > u.tEnd ? m.t - u.tEnd : undefined;
    const gap = during ? 0 : (before ?? after)!;
    if (gap > NEAREST_MAX_MS || (best && gap >= best.gap)) continue;
    const secs = Math.max(1, Math.round(gap / 1000));
    const verb = m.isImage ? 'pasted' : before !== undefined ? 'ended' : 'started';
    const when = during ? 'while speaking' : before !== undefined ? `${secs}s before` : `${secs}s after`;
    best = { gap, text: `${m.label}, ${verb} ${when}` };
  }
  return best?.text;
}

/**
 * Picks the groups an utterance refers to. Every group drawn while it is spoken counts.
 * With none, the latest group that ended within 1.5 s before it counts instead.
 */
function anchors(u: Utterance, groups: Group[]): { groups: Group[]; after: boolean } {
  const during = groups.filter((g) => g.t <= u.tEnd && g.tEnd >= u.t);
  if (during.length > 0) return { groups: during, after: false };
  const before = groups.filter((g) => g.tEnd < u.t && g.tEnd >= u.t - ANCHOR_BEFORE_MS);
  return { groups: before.slice(-1), after: true };
}

// ── Output ────────────────────────────────────────────────────────────────

interface Line {
  t: number;
  tEnd: number;
  order: number;
  text: string;
}

export function trimSpeech(texts: string[], max = SPEECH_MAX_CHARS): string {
  const all = texts.join(' ').replace(/\s+/g, ' ').trim();
  return all.length <= max ? all : `${all.slice(0, max - 1).trimEnd()}…`;
}

export function buildTimeline(input: TimelineInput): Timeline {
  const { bounds } = input;
  const strokes = meaningful(input.strokes);
  const utterances = [...input.utterances].sort((a, b) => a.t - b.t);
  const { adds, numbers } = numberStrokes(strokes);
  const groups = group(adds);
  // Elements whose last change was an erase.
  const last = new Map<string, StrokeEvent>();
  for (const s of [...strokes].sort((a, b) => a.t - b.t)) last.set(s.elementId, s);
  const gone = new Set([...last.values()].filter((s) => s.kind === 'erase').map((s) => s.elementId));
  const imageAdds = strokes.filter((s) => s.kind === 'add' && s.type === 'image' && s.by === 'user');
  const letters: Record<string, string> = {};
  for (const s of imageAdds) if (!gone.has(s.elementId) && !(s.elementId in letters)) letters[s.elementId] = letterFor(Object.keys(letters).length);
  // Lettered images first, so they win a tie with the same image listed from the scene.
  const images: PlacedImage[] = [
    ...imageAdds.filter((s) => letters[s.elementId]).map((s) => ({ box: s.bbox, letter: letters[s.elementId] })),
    ...(input.images ?? []).map((box) => ({ box })),
  ];
  const where = (box: Box) => imageWords(box, images) ?? positionWords(box, bounds);
  const spoken = joinSpeech(utterances);

  const describe = (g: Group) => {
    const first = numbers[g.strokes[0].elementId];
    const last = numbers[g.strokes[g.strokes.length - 1].elementId];
    const label = g.strokes.length === 1 ? `stroke ${first}` : `strokes ${first}–${last}`;
    const types = new Set(g.strokes.map((s) => typeWord(s.type)));
    const kind = types.size === 1 ? [...types][0] : 'mixed';
    const box = union(g.strokes.map((s) => s.bbox));
    return { label, details: [kind, where(box), sizeWords(box, bounds)] };
  };

  const nameOf = (s: StrokeEvent) =>
    numbers[s.elementId] ? `stroke ${numbers[s.elementId]}` : s.type === 'image' ? (letters[s.elementId] ? `image ${letters[s.elementId]}` : 'an image') : s.elementId;

  const lines: Line[] = [];

  const marks: Mark[] = [
    ...groups
      .filter((g) => !g.strokes.every((s) => gone.has(s.elementId)))
      .map((g) => ({ label: describe(g).label, t: g.t, tEnd: g.tEnd, isImage: false })),
    ...imageAdds
      .filter((s) => letters[s.elementId])
      .map((s) => ({ label: `image ${letters[s.elementId]}`, t: s.t, tEnd: s.tEnd, isImage: true })),
  ];

  for (const u of spoken) {
    const { groups: hit, after } = anchors(u, groups);
    for (const g of hit) g.named = true;
    let text = `🎙️ ${quote(u.text)}`;
    if (hit.length > 0) {
      const cap = u.tEnd - u.t > LONG_UTTERANCE_MS ? MAX_LONG_REFS : hit.length;
      const refs = hit.slice(0, cap).map((g) => {
        const d = describe(g);
        return `${d.label} (${d.details.join(', ')})`;
      });
      const more = hit.length - refs.length;
      if (more > 0) refs.push(`${more} more`);
      const list = refs.length === 1 ? refs[0] : `${refs.slice(0, -1).join(', ')} and ${refs[refs.length - 1]}`;
      text += ` — ${after ? 'just after' : 'while'} drawing ${list}`;
    } else {
      const near = nearest(u, marks);
      if (near) text += ` — nearest: ${near}`;
    }
    lines.push({ t: u.t, tEnd: u.tEnd, order: 1, text });
  }

  for (const g of groups) {
    if (g.named) continue;
    const d = describe(g);
    lines.push({ t: g.t, tEnd: g.tEnd, order: 0, text: [d.label, ...d.details].join(' · ') });
  }

  for (const s of strokes) {
    if (s.by === 'claude' && s.kind === 'add') {
      const name = [s.elementId, typeWord(s.type), s.label ? quote(s.label) : ''].filter(Boolean).join(' ');
      lines.push({ t: s.t, tEnd: s.tEnd, order: 0, text: `Claude drew ${name} · ${positionWords(s.bbox, bounds)}` });
    } else if (s.type === 'image' && s.kind === 'add') {
      const name = letters[s.elementId] ? `image ${letters[s.elementId]}` : 'image (erased later)';
      const text = `pasted ${name} · ${positionWords(s.bbox, bounds)} · ${sizeWords(s.bbox, bounds)}`;
      lines.push({ t: s.t, tEnd: s.tEnd, order: 0, text });
    } else if (s.kind === 'move') {
      const who = s.by === 'claude' ? 'Claude ' : '';
      lines.push({ t: s.t, tEnd: s.tEnd, order: 0, text: `${who}moved ${nameOf(s)}` });
    }
  }

  // Erases at the same moment, such as an image and the strokes on it, share a line.
  let erased: { by: StrokeEvent['by']; t: number; names: string[] } | undefined;
  const flushErased = () => {
    if (!erased) return;
    const list = erased.names.length === 1 ? erased.names[0] : `${erased.names.slice(0, -1).join(', ')} and ${erased.names.at(-1)}`;
    lines.push({ t: erased.t, tEnd: erased.t, order: 0, text: `${erased.by === 'claude' ? 'Claude ' : ''}erased ${list}` });
    erased = undefined;
  };
  for (const s of strokes.filter((x) => x.kind === 'erase').sort((a, b) => a.t - b.t)) {
    if (erased && (erased.by !== s.by || s.t - erased.t >= ERASE_JOIN_MS)) flushErased();
    erased ??= { by: s.by, t: s.t, names: [] };
    erased.names.push(nameOf(s));
  }
  flushErased();

  const body = lines
    .map((l, i) => ({ l, i }))
    .sort((a, b) => a.l.t - b.l.t || a.l.order - b.l.order || a.i - b.i)
    .map(({ l }) => `${stamp(l.t, l.tEnd)} ${l.text}`);

  const duration = Math.max(0, ...input.strokes.map((s) => s.tEnd), ...utterances.map((u) => u.tEnd));
  const claudeCount = strokes.filter((s) => s.by === 'claude' && s.kind === 'add').length;
  const keptAndErased = (ids: string[], one: string) => {
    const erasedCount = ids.filter((id) => gone.has(id)).length;
    return plural(ids.length - erasedCount, one) + (erasedCount ? ` (${erasedCount} erased)` : '');
  };
  const imageIds = [...new Set(imageAdds.map((s) => s.elementId))];
  const counts = [
    keptAndErased(Object.keys(numbers), 'stroke'),
    ...(imageIds.length ? [keptAndErased(imageIds, 'image')] : []),
    `${claudeCount} Claude ${claudeCount === 1 ? 'element' : 'elements'}`,
    plural(spoken.length, 'utterance'),
  ];
  const md = [
    `# Sketch timeline: ${input.boardName ?? 'board'}`,
    '',
    `Duration ${clock(duration)} · ${counts.join(' · ')}`,
    '',
    ...body,
  ];

  if (utterances.length > 0) {
    md.push('', '## Audio', '');
    for (const u of utterances) {
      md.push(`- ${stamp(u.t, u.tEnd)} ${u.audio} at ${seconds(u.t - u.audioStart)}`);
    }
  }

  return {
    timelineMd: md.join('\n') + '\n',
    transcript: utterances,
    speech: trimSpeech(utterances.map((u) => u.text)),
    strokeNumbers: numbers,
    imageLetters: letters,
  };
}
