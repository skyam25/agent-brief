/** Small text and value helpers the validators and summaries share. */

/** Collapses runs of whitespace, newlines included, into single spaces. */
export const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Shortens to `max` characters, ending with an ellipsis when cut. */
export const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

export const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
