/** Comments on a Write note: each one quotes the passage it is about. Send writes them as annotations.md. */

/** One comment on a passage of a note. */
export interface NoteComment {
  id: string;
  /** The passage, as plain text. Blocks are joined with a newline. */
  quote: string;
  /** Which match of `quote` in the note, counting from 0, when the words repeat. */
  occurrence: number;
  /** The nearest heading above the passage. */
  heading?: string;
  text: string;
  createdAt: number;
}

/** A note's comments, and words about the note as a whole. */
export interface NoteAnnotations {
  comments: NoteComment[];
  overall?: string;
}

/** Annotations as a Send hands them over, with the note's name, and its id when Claude revises it in place. */
export interface AnnotationsPayload extends NoteAnnotations {
  title?: string;
  noteId?: string;
}

export const MAX_NOTE_COMMENTS = 100;
const COMMENT_ID = /^[\w-]{1,40}$/;

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const clip = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.slice(0, max) : undefined);

/** Checks annotations from the renderer and keeps only known fields. Undefined when there are none. */
export function cleanAnnotations(raw: unknown): NoteAnnotations | undefined {
  if (!isRecord(raw)) return undefined;
  const comments: NoteComment[] = [];
  for (const c of Array.isArray(raw.comments) ? raw.comments.slice(0, MAX_NOTE_COMMENTS) : []) {
    if (!isRecord(c) || typeof c.id !== 'string' || !COMMENT_ID.test(c.id)) continue;
    const quote = clip(c.quote, 4000);
    if (!quote) continue;
    const heading = clip(c.heading, 300);
    const occurrence = typeof c.occurrence === 'number' && Number.isInteger(c.occurrence) && c.occurrence >= 0 ? c.occurrence : 0;
    comments.push({
      id: c.id,
      quote,
      occurrence,
      ...(heading ? { heading } : {}),
      text: typeof c.text === 'string' ? c.text.slice(0, 20_000) : '',
      createdAt: typeof c.createdAt === 'number' && Number.isFinite(c.createdAt) ? c.createdAt : 0,
    });
  }
  const overall = clip(raw.overall, 20_000);
  if (!comments.length && !overall?.trim()) return undefined;
  return { comments, ...(overall ? { overall } : {}) };
}

/** True when there is something to send: a comment or words about the whole note. */
export const hasAnnotations = (a: NoteAnnotations | undefined): boolean => !!a && (a.comments.length > 0 || !!a.overall?.trim());

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** The note's name in the prompt and in annotations.md. */
export const noteName = (title: string | undefined, source: string | undefined) =>
  source ?? (title?.trim() ? `the note “${oneLine(title)}”` : 'the note');

/** The annotations.md a Send writes. `draftFile` is where the note's text went. */
export function annotationsMarkdown(a: AnnotationsPayload, draftFile: string, source?: string): string {
  const lines = [
    `# Comments on ${noteName(a.title, source)}`,
    '',
    `Comments the user marked on the text in Agent Brief. Each quotes the passage it is about. The full text, with any edits, is in ${draftFile}.`,
  ];
  const overall = a.overall?.trim();
  if (overall) lines.push('', '## Overall', '', overall);
  a.comments.forEach((c, i) => {
    lines.push('', `## ${i + 1}. “${cut(oneLine(c.quote), 60)}”`, '', c.text.trim() || '(No words. The user highlighted this passage.)', '');
    if (c.heading) lines.push(`- Under heading: “${cut(oneLine(c.heading), 120)}”`);
    lines.push(`- Passage: “${cut(oneLine(c.quote), 600)}”`);
    if (c.occurrence > 0) lines.push(`- These words appear more than once. This is match ${c.occurrence + 1}.`);
  });
  return `${lines.join('\n')}\n`;
}

/** The prompt line after the `@draft.md` and `@annotations.md` lines. */
export function annotationsAsk(a: AnnotationsPayload, source?: string): string {
  const n = a.comments.length;
  const what = n ? `${n} comment${n === 1 ? '' : 's'} on passages` : 'an overall comment';
  if (source) return `Comments on ${source} from Agent Brief, ${what}. Make the changes in ${source}, keep what the comments do not touch, then say what changed.`;
  if (a.noteId) {
    return `Comments on ${noteName(a.title, undefined)} from Agent Brief, ${what}. Revise the note in place: run \`agent-brief note --id ${a.noteId}\` with the full new text, then \`agent-brief open --note ${a.noteId}\`, then say what changed.`;
  }
  const title = a.title?.trim() ? oneLine(a.title) : 'Revised note';
  return `Comments on ${noteName(a.title, undefined)} from Agent Brief, ${what}. Revise the note to address them, save the new version with \`agent-brief note "${title}"\`, open it with the line that command prints, then say what changed.`;
}
