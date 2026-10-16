/**
 * Edits the review pane makes to an HTML file. Each element the pane can edit
 * carries `data-ab-at`, the offset of its start tag in the file as served, so
 * an edit names its element by where it sits in the source.
 */

/** The attribute that names an element's place in the source. */
export const AT_ATTR = 'data-ab-at';

/** Set on a page's ground, such as a canvas's pan surface: never selected, and presses reach the page. */
export const GROUND_ATTR = 'data-ab-ground';

/** Set on page chrome the page drives itself in edit mode, such as artboard name strips. */
export const PASS_ATTR = 'data-ab-pass';

/** A page's own edits, such as a dragged artboard frame, as a DOM event on `document`. */
export const PAGE_EDIT_EVENT = 'agent-brief:edit';

export type StyleSet = Record<string, string | null>;

/** Ready-made markup the inspector inserts. */
export const INSERTS = {
  text: '<p>Text</p>',
  row: '<div style="display: flex; gap: 8px; align-items: center"></div>',
  column: '<div style="display: flex; flex-direction: column; gap: 8px"></div>',
  button: '<button type="button">Button</button>',
} as const;

export type InsertKind = keyof typeof INSERTS;

export type ReviewEdit =
  /** Replaces the words of an element that holds only text. */
  | { kind: 'text'; at: number; text: string }
  /** Sets or, with null, removes inline style properties. */
  | { kind: 'style'; at: number; set: StyleSet }
  /** Sets or, with null, removes attributes. */
  | { kind: 'attrs'; at: number; set: Record<string, string | null> }
  /** Moves an element into `parent`, before `before` or last when it is null. */
  | { kind: 'move'; at: number; parent: number; before: number | null }
  | { kind: 'remove'; at: number }
  /** Adds a copy right after the element. */
  | { kind: 'duplicate'; at: number }
  /** Adds ready-made markup into `parent`, before `before` or last. */
  | { kind: 'insert'; parent: number; before: number | null; what: InsertKind };

/** What main answers for an edit. */
export type EditResult =
  /** `offsets` are every editable element's new `data-ab-at`, in document order. `at` is the edited element's. */
  | { ok: true; version: string; offsets: number[]; at?: number; summary: string }
  /** `stale` means the file changed since the page loaded, so the page has to reload. */
  | { ok: false; error: string; stale?: boolean };

/** What main answers for undo and redo. The page reloads after either. */
export type HistoryResult = { ok: true; summary: string } | { ok: false; error: string };

/** The style properties the inspector shows, in its order. */
export const INSPECTOR_PROPS = [
  'display',
  'flex-direction',
  'gap',
  'align-items',
  'justify-content',
  'width',
  'height',
  'padding',
  'margin',
  'font-size',
  'font-weight',
  'color',
  'background',
  'border-radius',
] as const;

export type InspectorProp = (typeof INSPECTOR_PROPS)[number];

/** The element the overlay has selected, as the inspector shows it. */
export interface SelectedElement {
  at: number;
  /** Tag and a few of its words, like `button “Talk”`. */
  label: string;
  /** The words, when the element holds only text. */
  text?: string;
  /** Inline values, empty when unset. */
  inline: Partial<Record<InspectorProp, string>>;
  /** What the page computed, shown as placeholders. */
  computed: Partial<Record<InspectorProp, string>>;
  /** True when the element can hold other elements. */
  isContainer: boolean;
  hasParent: boolean;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isAt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const isRef = (v: unknown): v is number | null => v === null || isAt(v);
const PROP = /^-{0,2}[a-z][a-z0-9-]*$/;
const ATTR = /^[a-z_:][a-z0-9_:.-]*$/;

function cleanSet(raw: unknown, key: RegExp, max = 2000): Record<string, string | null> | undefined {
  if (!isRecord(raw)) return undefined;
  const out: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(raw).slice(0, 40)) {
    if (!key.test(k) || k.startsWith('on')) continue;
    if (v === null) out[k] = null;
    else if (typeof v === 'string' && v.length <= max) out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Checks an edit from the renderer. Undefined when it is not one. Event handler attributes never pass. */
export function cleanEdit(raw: unknown): ReviewEdit | undefined {
  if (!isRecord(raw)) return undefined;
  switch (raw.kind) {
    case 'text':
      return isAt(raw.at) && typeof raw.text === 'string' && raw.text.length <= 20_000 ? { kind: 'text', at: raw.at, text: raw.text } : undefined;
    case 'style': {
      const set = cleanSet(raw.set, PROP);
      return isAt(raw.at) && set ? { kind: 'style', at: raw.at, set } : undefined;
    }
    case 'attrs': {
      const set = cleanSet(raw.set, ATTR);
      return isAt(raw.at) && set ? { kind: 'attrs', at: raw.at, set } : undefined;
    }
    case 'move':
      return isAt(raw.at) && isAt(raw.parent) && isRef(raw.before) ? { kind: 'move', at: raw.at, parent: raw.parent, before: raw.before } : undefined;
    case 'remove':
    case 'duplicate':
      return isAt(raw.at) ? { kind: raw.kind, at: raw.at } : undefined;
    case 'insert':
      return isAt(raw.parent) && isRef(raw.before) && typeof raw.what === 'string' && raw.what in INSERTS
        ? { kind: 'insert', parent: raw.parent, before: raw.before, what: raw.what as InsertKind }
        : undefined;
    default:
      return undefined;
  }
}
