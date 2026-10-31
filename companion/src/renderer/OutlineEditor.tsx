/**
 * The outline editor in Write. The `.outline.md` file holds the outline, and every change
 * goes out as id-targeted ops, so your edits and Claude's land in the same file.
 * A field you are typing in keeps its words while the file reloads under it.
 * The header and the Ask field hand Claude fixed prompts through the session's Send.
 */

import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from 'react';
import type { CiteMark, DirectionScope, OutlineCite, OutlineDocument, OutlineOp, OutlinePoint, OutlineSection, OutlineSource, OutlineUpdateResult } from '../protocol';
import { concerns, type CompanionApi, type Draft } from '../shared/ipc';
import type { OutlineChanges, OutlineRowChange, RowChangeKind } from '../shared/outline-changes';
import { acceptDirectionPrompt, askPrompt, generatePrompt } from '../shared/outline-prompts';
import type { SendFeedback } from './FeedbackPanel';
import { CloseIcon, ExternalIcon, LinkIcon, PlusIcon } from './Icons';
import {
  ACCEPT_LABEL,
  acceptedDirection,
  CHANGES_SHOWN,
  addPendingOp,
  citeLabel,
  citesWith,
  citeTitle,
  directionHeadline,
  dropPending,
  intentOp,
  intentRows,
  leavesRow,
  MARK_GLYPH,
  oneLine,
  openableRef,
  pointMoveOp,
  pointTextOp,
  resolvePending,
  scopeLine,
  sectionRows,
  shownChanges,
  splitOpen,
  targetName,
  type PendingAfter,
  type PendingPoint,
} from './outline-edit';
import { cleanError } from './ipc-error';
import { useOutputWatch, type OutputWatchHost } from './output-watch';
import type { FixedSend } from './useSend';

export type OutlineHost = Pick<
  CompanionApi,
  'readOutline' | 'updateOutline' | 'onOutlineChanged' | 'outlineChanges' | 'markOutlineReviewed' | 'openOutput' | 'onOutputs' | 'onVisibility'
> &
  OutputWatchHost;

type Ops = OutlineOp[] | (() => OutlineOp[]);

export interface OutlineDocState {
  doc?: OutlineDocument;
  error?: string;
  /** The newest document, before React renders it. */
  current: () => OutlineDocument | undefined;
  reload: () => Promise<OutlineDocument | undefined>;
  /**
   * Queues a write. Writes run one at a time, so each one starts from the last one's version,
   * and a lazy `ops` reads the outline as it stands then. `done` runs before the next write starts.
   */
  apply: (ops: Ops, done?: (result: OutlineUpdateResult) => void) => Promise<OutlineUpdateResult | undefined>;
  /** Resolves once every queued write has finished. */
  settle: () => Promise<unknown>;
}

/** An outline file, kept current with the store's writes and outside edits. */
export function useOutlineDoc(host: OutlineHost, sessionId: string | undefined, path: string): OutlineDocState {
  const [doc, setDoc] = useState<OutlineDocument>();
  const [error, setError] = useState<string>();
  const request = useRef(0);
  const live = useRef<OutlineDocument>(undefined);
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const load = useCallback(async () => {
    if (!sessionId) return undefined;
    const n = ++request.current;
    try {
      const next = await host.readOutline(sessionId, path);
      if (n === request.current) {
        live.current = next;
        setDoc(next);
        setError(undefined);
      }
      return next;
    } catch (err) {
      if (n === request.current) setError(cleanError(err));
      return undefined;
    }
  }, [host, sessionId, path]);
  useEffect(() => {
    live.current = undefined;
    setDoc(undefined);
    void load();
    const off = host.onOutlineChanged((c) => {
      if (c.path === path && concerns(c, sessionId)) void load();
    });
    return () => {
      ++request.current;
      off();
    };
  }, [load, host, path, sessionId]);
  useOutputWatch(host, sessionId, path, () => void load());

  // A target Claude writes is not watched until it exists, so a declared output or a return to the panel reads again.
  useEffect(() => {
    if (!sessionId) return;
    const reload = () => void load();
    const offOutputs = host.onOutputs((info) => info.sessionId === sessionId && reload());
    const offVisible = host.onVisibility((visible) => visible && reload());
    window.addEventListener('focus', reload);
    return () => {
      if (typeof offOutputs === 'function') offOutputs();
      if (typeof offVisible === 'function') offVisible();
      window.removeEventListener('focus', reload);
    };
  }, [load, host, sessionId]);

  const apply = useCallback(
    (ops: Ops, done?: (result: OutlineUpdateResult) => void) => {
      const run = async () => {
        const list = typeof ops === 'function' ? ops() : ops;
        if (!sessionId || !list.length) return undefined;
        try {
          const next = await host.updateOutline(sessionId, path, { ops: list });
          ++request.current;
          live.current = next;
          setDoc(next);
          setError(undefined);
          done?.(next);
          return next;
        } catch (err) {
          setError(cleanError(err));
          return undefined;
        }
      };
      const result = chain.current.then(run);
      chain.current = result;
      return result;
    },
    [host, sessionId, path, load],
  );
  return { doc, error, current: () => live.current, reload: load, apply, settle: () => chain.current };
}

/** What Claude changed since you last marked the outline reviewed, read again whenever the file changes. */
function useOutlineChanges(host: OutlineHost, sessionId: string | undefined, path: string, version: string | undefined) {
  const [changes, setChanges] = useState<OutlineChanges>();
  const request = useRef(0);
  useEffect(() => {
    if (!sessionId || !version) return;
    const n = ++request.current;
    void host
      .outlineChanges(sessionId, path)
      .catch(() => undefined)
      .then((next) => n === request.current && setChanges(next));
  }, [host, sessionId, path, version]);
  const markReviewed = async () => {
    if (!sessionId) return;
    ++request.current;
    await host.markOutlineReviewed(sessionId, path);
    setChanges(undefined);
  };
  return { changes, markReviewed };
}

const CHANGE_LABEL: Record<RowChangeKind, string> = { added: 'New', edited: 'Edited', removed: 'Removed' };

function ChangeBadge(props: { change: RowChangeKind }) {
  return <span className={`outline-change-badge ${props.change}`} data-testid="outline-change-badge">{CHANGE_LABEL[props.change]}</span>;
}

/** The old wording of an edited row. */
function WasLines(props: { change?: OutlineRowChange }) {
  if (props.change?.change !== 'edited' || !props.change.was.length) return null;
  return (
    <div className="outline-was" data-testid="outline-was">
      {props.change.was.map((w, i) => (
        <p key={i}>
          <span>Was</span> {w}
        </p>
      ))}
    </div>
  );
}

/** A removed point, struck through where it stood. */
function RemovedPoint(props: { change: OutlineRowChange }) {
  return (
    <li className="outline-point removed" data-change="removed" data-testid="outline-removed-point">
      <div className="outline-point-line">
        <span className="outline-marker" aria-hidden="true" />
        <s className="outline-removed-text">{props.change.was[0]}</s>
        <ChangeBadge change="removed" />
      </div>
    </li>
  );
}

/**
 * `rows` with each removed row drawn after the row it followed, in the old order.
 * It goes first when it led, and last when the row it followed is gone or moved.
 */
function placeRemoved(rows: { id?: string; node: ReactNode }[], removed: OutlineRowChange[], draw: (c: OutlineRowChange) => ReactNode): ReactNode[] {
  const out = rows.map((r) => r.node);
  const ids = rows.map((r) => r.id);
  for (const r of removed) {
    const prior = r.after === null || r.after === undefined ? -1 : ids.lastIndexOf(r.after);
    const at = r.after === null ? 0 : prior < 0 ? out.length : prior + 1;
    out.splice(at, 0, draw(r));
    ids.splice(at, 0, r.id);
  }
  return out;
}

const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

type FieldElement = HTMLInputElement | HTMLTextAreaElement;

/** The tops of the caret's visual line and of the field's first and last lines, from a hidden copy of the field. */
function caretTops(el: HTMLTextAreaElement): { caret: number; first: number; last: number } {
  const style = getComputedStyle(el);
  const mirror = document.createElement('div');
  for (const name of ['box-sizing', 'width', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width', 'border-style', 'font-family', 'font-size', 'font-weight', 'font-style', 'letter-spacing', 'line-height', 'word-spacing', 'text-indent', 'tab-size']) {
    mirror.style.setProperty(name, style.getPropertyValue(name));
  }
  Object.assign(mirror.style, { position: 'absolute', top: '0', left: '-9999px', visibility: 'hidden', whiteSpace: 'pre-wrap', overflowWrap: 'break-word' });
  document.body.append(mirror);
  const text = el.value;

  // A span holding the rest of the text starts on the line the caret sits on.
  const top = (at: number) => {
    mirror.textContent = text.slice(0, at);
    const rest = document.createElement('span');
    rest.textContent = text.slice(at) || '.';
    mirror.append(rest);
    return rest.offsetTop;
  };
  const tops = { caret: top(el.selectionStart), first: top(0), last: top(text.length) };
  mirror.remove();
  return tops;
}

/**
 * A field over a value from the file. Once you type, it keeps your words until it loses focus,
 * whatever the file says meanwhile. It commits on blur, or when a key handler asks.
 * A `wrap` field is a textarea that grows with its text. Enter never adds a line break.
 */
function Field(props: {
  value: string;
  onCommit: (text: string) => void;
  /** Gets the words shown and a commit that a later blur will not repeat. */
  onKey?: (e: ReactKeyboardEvent<FieldElement>, text: string, commit: () => void) => void;
  /** Runs on blur with the words shown, after any commit. */
  onLeave?: (text: string) => void;
  /** Blank words go back to the file's value on blur. */
  required?: boolean;
  /** Takes focus when this turns true. */
  focus?: boolean;
  onFocus?: () => void;
  label: string;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  testId?: string;
  /** Marks a point row's field, for ↑ and ↓ between rows. */
  row?: boolean;
  wrap?: boolean;
}) {
  const ref = useRef<FieldElement>(null);
  const [typed, setTyped] = useState<string>();
  const editing = useRef(false);
  const sent = useRef<string>(undefined);
  // A new value from the file shows, unless you are typing here.
  useEffect(() => {
    if (!editing.current) setTyped(undefined);
  }, [props.value]);
  useEffect(() => {
    if (props.focus) ref.current?.focus();
  }, [props.focus]);
  const text = typed ?? props.value;
  const commit = () => {
    if (typed === undefined || typed === props.value || typed === sent.current) return;
    sent.current = typed;
    props.onCommit(typed);
  };
  const shared = {
    className: props.className ? `outline-field ${props.className}` : 'outline-field',
    'aria-label': props.label,
    placeholder: props.placeholder,
    disabled: props.disabled,
    value: text,
    spellCheck: true,
    onFocus: () => {
      editing.current = true;
      sent.current = undefined;
      props.onFocus?.();
    },
    onBlur: () => {
      editing.current = false;
      commit();
      if (props.required && !text.trim()) setTyped(undefined);
      props.onLeave?.(text);
    },
    'data-row': props.row || undefined,
    'data-testid': props.testId,
  };
  if (!props.wrap) {
    return <input ref={ref as RefObject<HTMLInputElement>} {...shared} onChange={(e) => setTyped(e.target.value)} onKeyDown={(e) => props.onKey?.(e, text, commit)} />;
  }
  return (
    <textarea
      ref={ref as RefObject<HTMLTextAreaElement>}
      rows={1}
      {...shared}
      onChange={(e) => setTyped(oneLine(e.target.value))}
      onKeyDown={(e) => {
        props.onKey?.(e, text, commit);
        if (e.key !== 'Enter' || e.defaultPrevented) return;
        e.preventDefault();
        e.currentTarget.blur();
      }}
    />
  );
}

/** ↑ or ↓ in a wrapped field: true when the caret is on the line that leaves the field that way. */
const atRowEdge = (el: EventTarget, dir: -1 | 1) => {
  if (!(el instanceof HTMLTextAreaElement)) return true;
  if (el.selectionStart !== el.selectionEnd) return false;
  return leavesRow(dir, caretTops(el));
};

const MARKS: CiteMark[] = ['supports', 'partly', 'not', 'unknown'];

const findPoint = (doc: OutlineDocument | undefined, id: string) => doc?.sections.flatMap((s) => s.points).find((p) => p.id === id);

/** A button that asks for a second click before it removes. */
function RemoveButton(props: { label: string; testId: string; onRemove: () => void }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(timer);
  }, [armed]);
  return (
    <button
      className={armed ? 'ghost small outline-remove armed' : 'ghost icon-button small outline-remove'}
      aria-label={props.label}
      title={armed ? 'Click again to remove' : props.label}
      onClick={() => (armed ? props.onRemove() : setArmed(true))}
      data-testid={props.testId}
    >
      {armed ? 'Remove?' : <CloseIcon />}
    </button>
  );
}

export function OutlineEditor(props: {
  host: OutlineHost;
  draft: Draft;
  onSend: SendFeedback;
  onError: (message: string) => void;
  /** The file's title changed, so the list row follows it. */
  onRetitle: (title: string) => void;
  onCopyReference: () => void;
}) {
  const sessionId = props.draft.sessionId;
  const path = props.draft.outline!.path;
  const outline = useOutlineDoc(props.host, sessionId, path);
  const { doc, apply } = outline;
  const { changes: changed, markReviewed } = useOutlineChanges(props.host, sessionId, path, doc?.version);
  /** The mark Next change showed last. */
  const nextMark = useRef(-1);
  // Claude writing the target shows its tab.
  useOutputWatch(props.host, doc?.target ? sessionId : undefined, doc?.target ?? '', () => void outline.reload());

  const root = useRef<HTMLElement>(null);
  const [collapsed, setCollapsed] = useState(() => new Set<string>());
  const [expanded, setExpanded] = useState<string>();
  const [highlight, setHighlight] = useState<string>();
  /** The section Ask Claude talks about. */
  const [askSection, setAskSection] = useState<string>();
  const [ask, setAsk] = useState('');
  const [addingSection, setAddingSection] = useState(false);
  const [addingSource, setAddingSource] = useState(false);
  const [allChanges, setAllChanges] = useState(false);
  /** The row to put the cursor in once it shows: `p:<id>`, `n:<key>`, `s:<id>` or `new-section`. */
  const [focusKey, setFocusKey] = useState<string>();

  // Pending rows live in a ref too, so a queued addPoint reads where its row stands when it runs.
  const pendingRef = useRef<PendingPoint[]>([]);
  const [pending, setPendingState] = useState<PendingPoint[]>([]);
  const setPending = (next: (p: PendingPoint[]) => PendingPoint[]) => {
    pendingRef.current = next(pendingRef.current);
    setPendingState(pendingRef.current);
  };
  const nextKey = useRef(0);
  /** The new section's title was committed with Enter, so its first point opens. */
  const enterSection = useRef(false);
  const newPending = (section: string, after: PendingAfter) => {
    const key = `n${++nextKey.current}`;
    setPending((p) => [...p, { key, section, after }]);
    setFocusKey(`n:${key}`);
  };

  useEffect(() => {
    if (doc?.title && doc.title !== props.draft.title) props.onRetitle(doc.title);
  }, [doc?.title]);

  // A section Claude removed takes its pending rows and the Ask scope with it.
  useEffect(() => {
    if (!doc) return;
    const ids = new Set(doc.sections.map((s) => s.id));
    if (pendingRef.current.some((p) => !ids.has(p.section))) setPending((p) => p.filter((x) => ids.has(x.section)));
    if (askSection && !ids.has(askSection)) setAskSection(undefined);
  }, [doc]);

  if (!sessionId) {
    return (
      <section className="editor outline-editor empty-editor" data-testid="outline-editor">
        <p className="muted">This outline is not filed under a session, so it cannot read its file. Open it from its session.</p>
      </section>
    );
  }

  /** Commits what is being typed in the outline, waits for the writes, then hands Claude what `build` makes from a fresh read. */
  const send = (build: (fresh: OutlineDocument) => FixedSend | string) => {
    props.onSend(sessionId, async () => {
      const active = document.activeElement;
      if (active instanceof HTMLElement && root.current?.contains(active)) active.blur();
      await outline.settle();
      const fresh = await outline.reload();
      if (!fresh) return 'Could not read the outline. Nothing was sent.';
      return build(fresh);
    });
  };
  const sendDirection = (scope: DirectionScope) =>
    send((fresh) => {
      const accepted = acceptedDirection(fresh, scope);
      if (!accepted) return 'The direction is gone from the outline.';
      return {
        text: acceptDirectionPrompt(fresh, scope),
        onSent: async () => {
          if (!(await apply([accepted]))) throw new Error('could not mark the direction accepted.');
        },
      };
    });

  /** Moves the cursor to the point row above, at its end, or below, at its start. */
  const focusRow = (from: HTMLElement, dir: -1 | 1) => {
    const rows = [...(root.current?.querySelectorAll<FieldElement>('[data-row]') ?? [])];
    const to = rows[rows.indexOf(from as FieldElement) + dir];
    if (!to) return;
    to.focus();
    const at = dir === -1 ? to.value.length : 0;
    to.setSelectionRange(at, at);
  };

  const editCites = (id: string, change: (cites: OutlineCite[]) => OutlineCite[]) =>
    void apply(() => {
      const p = findPoint(outline.current(), id);
      return p ? [{ op: 'editPoint', id, cites: change(p.cites) }] : [];
    });

  const pointKeys = (section: OutlineSection, point: OutlinePoint) => (e: ReactKeyboardEvent<FieldElement>, text: string, commit: () => void) => {
    const plain = !e.metaKey && !e.ctrlKey && !e.shiftKey;
    if (e.key === 'Enter' && plain && !e.altKey) {
      e.preventDefault();
      commit();
      newPending(section.id, { id: point.id });
    } else if (e.key === 'Backspace' && text === '' && plain && !e.altKey) {
      e.preventDefault();
      focusRow(e.currentTarget, -1);
      void apply([{ op: 'removePoint', id: point.id }]);
    } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && plain) {
      const dir = e.key === 'ArrowUp' ? -1 : 1;
      if (!e.altKey) {
        if (!atRowEdge(e.currentTarget, dir)) return;
        e.preventDefault();
        return focusRow(e.currentTarget, dir);
      }
      e.preventDefault();
      commit();
      void apply(() => {
        const current = outline.current();
        const move = current && pointMoveOp(current, point.id, dir);
        return move ? [move] : [];
      });
      setFocusKey(`p:${point.id}`);
    }
  };

  const pendingKeys = (row: PendingPoint) => (e: ReactKeyboardEvent<FieldElement>, text: string, commit: () => void) => {
    const plain = !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
    if (e.key === 'Enter' && plain) {
      e.preventDefault();
      if (!splitOpen(text).text) return;
      commit();
      newPending(row.section, { key: row.key });
    } else if (e.key === 'Backspace' && text === '' && plain) {
      e.preventDefault();
      focusRow(e.currentTarget, -1);
      setPending((p) => dropPending(p, row.key));
    } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && plain) {
      const dir = e.key === 'ArrowUp' ? -1 : 1;
      if (!atRowEdge(e.currentTarget, dir)) return;
      e.preventDefault();
      focusRow(e.currentTarget, dir);
    }
  };

  const addPending = (row: PendingPoint, text: string) =>
    void apply(
      () => {
        const live = pendingRef.current.find((p) => p.key === row.key);
        const op = live && addPendingOp(live, text);
        return op ? [op] : [];
      },
      (result) => {
        const id = result.added[0];
        if (id) setPending((p) => resolvePending(p, row.key, id));
      },
    );

  /** Adds the new section. From Enter, the cursor moves to its first point. */
  const addSection = (title: string) => {
    if (!title.trim()) return;
    const into = enterSection.current;
    enterSection.current = false;
    void apply([{ op: 'addSection', title }], (result) => {
      setAddingSection(false);
      const id = result.added[0];
      if (id && into) newPending(id, { id: null });
    });
  };

  if (!doc) {
    return (
      <section className="editor outline-editor empty-editor" data-testid="outline-editor">
        {outline.error ? (
          <p role="alert" className="error" data-testid="outline-error">
            {outline.error}
          </p>
        ) : (
          <p className="muted">Loading the outline…</p>
        )}
      </section>
    );
  }

  const direction = doc.direction;
  const changes = shownChanges(direction?.changes ?? [], allChanges);
  const rowChanges = changed?.rows ?? [];
  const live = new Map(rowChanges.filter((c) => c.change !== 'removed').map((c) => [c.id, c]));
  const removed = (row: OutlineRowChange['row']) => rowChanges.filter((c) => c.change === 'removed' && c.row === row);
  const removedSections = removed('section');
  const showNextChange = () => {
    const marks = [...(root.current?.querySelectorAll<HTMLElement>('[data-change]') ?? [])];
    if (!marks.length) return;
    nextMark.current = (nextMark.current + 1) % marks.length;
    const mark = marks[nextMark.current]!;
    mark.scrollIntoView({ block: 'center' });
    mark.classList.remove('flash');
    requestAnimationFrame(() => mark.classList.add('flash'));
  };
  const hasPoints = doc.sections.some((s) => s.points.length);
  const sourceTitle = (id: string) => doc.sources.find((s) => s.id === id)?.title;
  const askTitle = doc.sections.find((s) => s.id === askSection)?.title;
  const showSource = (id: string) => {
    setHighlight(id);
    requestAnimationFrame(() => root.current?.querySelector(`[data-source="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' }));
  };
  const openRef = (ref: string) => void props.host.openOutput(sessionId, ref).catch((err) => props.onError(`Could not open ${ref}: ${cleanError(err)}`));
  const openTarget = () => doc.target && openRef(doc.target);
  const sourceRef = (id: string) => {
    const ref = doc.sources.find((s) => s.id === id)?.ref;
    return openableRef(ref) ? ref.trim() : undefined;
  };

  const pointRow = (section: OutlineSection, point: OutlinePoint) => {
    const open = point.kind === 'open';
    const more = expanded === point.id;
    const edit = (field: 'guide' | 'keep' | 'default') => (t: string) => void apply([{ op: 'editPoint', id: point.id, [field]: t.trim() || null } as OutlineOp]);
    const change = live.get(point.id);
    return (
      <li
        key={point.id}
        className={`outline-point${open ? ' open' : ''}${more ? ' expanded' : ''}${change ? ` changed ${change.change}` : ''}`}
        data-point={point.id}
        data-change={change?.change}
        data-testid="outline-point"
      >
        <div className="outline-point-line">
          <button
            className={open ? 'outline-marker open' : 'outline-marker'}
            aria-pressed={open}
            aria-label={open ? 'Open question. Click to make it a point.' : 'Point. Click to make it an open question.'}
            title={open ? 'Open question · click to make it a point' : 'Point · click to make it an open question'}
            onClick={() => void apply([{ op: 'editPoint', id: point.id, kind: open ? 'point' : 'open' }])}
            data-testid="outline-marker"
          >
            {open ? '?' : ''}
          </button>
          <Field
            row
            wrap
            className="outline-point-text"
            label={open ? 'Open question' : 'Point'}
            value={point.text}
            required
            focus={focusKey === `p:${point.id}`}
            onFocus={() => setFocusKey(undefined)}
            onCommit={(t) => {
              const op = pointTextOp(point, t);
              if (op) void apply([op]);
            }}
            onKey={pointKeys(section, point)}
            testId="outline-point-input"
          />
          {point.cites.map((c, i) => (
            <button
              key={i}
              className={`outline-cite ${c.mark ?? 'unchecked'}${highlight === c.source ? ' on' : ''}`}
              title={citeTitle(c, sourceTitle(c.source)) + (sourceRef(c.source) ? ' · ⌘-click to open' : '')}
              onClick={(e) => {
                const ref = sourceRef(c.source);
                if (ref && (e.metaKey || e.ctrlKey)) openRef(ref);
                else showSource(c.source);
              }}
              data-testid="outline-cite"
            >
              {citeLabel(c)}
            </button>
          ))}
          {change && <ChangeBadge change={change.change} />}
          <button
            className="ghost small outline-more"
            aria-expanded={more}
            title={more ? 'Hide guide, keep, default and cites' : 'Edit guide, keep, default and cites'}
            onClick={() => setExpanded(more ? undefined : point.id)}
            data-testid="outline-point-more"
          >
            {more ? '▾' : '▸'}
          </button>
        </div>
        <WasLines change={change} />
        {!more && (point.guide || point.keep || (open && point.default)) && (
          <div className="outline-point-notes">
            {point.guide && <p data-testid="outline-guide">Guide · {point.guide}</p>}
            {point.keep && <p className="keep">Keep · {point.keep}</p>}
            {open && point.default && <p>Default · {point.default}</p>}
          </div>
        )}
        {more && (
          <div className="outline-point-edit" data-testid="outline-point-edit">
            <label>
              <span>Guide</span>
              <Field wrap label="Guide" placeholder="How to say it: tone, emphasis, qualification" value={point.guide ?? ''} onCommit={edit('guide')} testId="outline-edit-guide" />
            </label>
            <label>
              <span>Keep</span>
              <Field wrap label="Keep" placeholder="A fact or wording that must survive a rewrite" value={point.keep ?? ''} onCommit={edit('keep')} testId="outline-edit-keep" />
            </label>
            {(open || point.default) && (
              <label>
                <span>Default</span>
                <Field wrap label="Default" placeholder="What the draft assumes until this is answered" value={point.default ?? ''} onCommit={edit('default')} testId="outline-edit-default" />
              </label>
            )}
            <div className="outline-cites-edit">
              {point.cites.map((c, i) => (
                <div key={`${i}-${c.source}`} className="outline-cite-row" data-testid="outline-cite-row">
                  <span className={`outline-cite ${c.mark ?? 'unchecked'}`} title={sourceTitle(c.source)}>
                    {c.source}
                  </span>
                  <Field label={`Where in ${c.source}`} placeholder="Where, such as p.3" value={c.location ?? ''} onCommit={(t) => editCites(point.id, (cites) => citesWith(cites, i, { ...cites[i]!, location: t }))} />
                  <select
                    aria-label={`Mark for ${c.source}`}
                    value={c.mark ?? ''}
                    onChange={(e) => {
                      const mark = (e.target.value || undefined) as CiteMark | undefined;
                      editCites(point.id, (cites) => citesWith(cites, i, { ...cites[i]!, mark }));
                    }}
                  >
                    <option value="">Unchecked</option>
                    {MARKS.map((m) => (
                      <option key={m} value={m}>
                        {MARK_GLYPH[m]} {m}
                      </option>
                    ))}
                  </select>
                  <Field label={`Note on ${c.source}`} placeholder={c.mark ? 'Why' : 'Mark it to add a note'} disabled={!c.mark} value={c.note ?? ''} onCommit={(t) => editCites(point.id, (cites) => citesWith(cites, i, { ...cites[i]!, note: t }))} />
                  <button className="ghost icon-button small" aria-label={`Remove the cite of ${c.source}`} title="Remove this cite" onClick={() => editCites(point.id, (cites) => citesWith(cites, i))}>
                    <CloseIcon />
                  </button>
                </div>
              ))}
              {doc.sources.length ? (
                <select aria-label="Add a cite" value="" onChange={(e) => {
                    // The write runs later, after React resets this select, so read the pick now.
                    const source = e.target.value;
                    if (source) editCites(point.id, (cites) => [...cites, { source }]);
                  }} data-testid="outline-add-cite">
                  <option value="">Add a cite…</option>
                  {doc.sources.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.id} · {s.title}
                    </option>
                  ))}
                </select>
              ) : (
                <p className="muted">Add a source in the rail, then cite it here.</p>
              )}
            </div>
          </div>
        )}
      </li>
    );
  };

  const pendingRow = (row: PendingPoint) => (
    <li key={row.key} className="outline-point pending" data-testid="outline-pending">
      <div className="outline-point-line">
        <span className="outline-marker" aria-hidden="true" />
        <Field
          row
          wrap
          className="outline-point-text"
          label="New point"
          placeholder="A point, or Open: a question"
          value=""
          focus={focusKey === `n:${row.key}`}
          onFocus={() => setFocusKey(undefined)}
          onCommit={(t) => addPending(row, t)}
          onLeave={(t) => {
            if (!splitOpen(t).text) setPending((p) => dropPending(p, row.key));
          }}
          onKey={pendingKeys(row)}
          testId="outline-point-input"
        />
      </div>
    </li>
  );

  const sectionBlock = (section: OutlineSection) => {
    const folded = collapsed.has(section.id);
    const rows = sectionRows(section, pending);
    const change = live.get(section.id);
    const nodes = placeRemoved(
      rows.map((r) => (r.kind === 'point' ? { id: r.point.id, node: pointRow(section, r.point) } : { node: pendingRow(r.pending) })),
      removedSections.some((r) => r.id === section.id) ? [] : removed('point').filter((c) => c.section === section.id),
      (c) => <RemovedPoint key={`removed-${c.id}`} change={c} />,
    );
    const toggle = () => setCollapsed((c) => {
      const next = new Set(c);
      if (!next.delete(section.id)) next.add(section.id);
      return next;
    });
    return (
      <section
        key={section.id}
        className={askSection === section.id ? 'outline-section current' : 'outline-section'}
        onFocus={() => setAskSection(section.id)}
        data-section={section.id}
        data-change={change?.change}
        data-testid="outline-section"
      >
        <header className="outline-section-head">
          <button className="ghost small outline-fold" aria-expanded={!folded} aria-label={folded ? 'Show the points' : 'Hide the points'} onClick={toggle} data-testid="outline-section-toggle">
            {folded ? '▸' : '▾'}
          </button>
          <Field
            className="outline-section-title"
            label="Section title"
            value={section.title}
            required
            focus={focusKey === `s:${section.id}`}
            onFocus={() => setFocusKey(undefined)}
            onCommit={(t) => {
              const title = t.replace(/\s+/g, ' ').trim();
              if (title && title !== section.title) void apply([{ op: 'editSection', id: section.id, title }]);
            }}
            onKey={(e, _text, commit) => {
              if (e.key !== 'Enter') return;
              e.preventDefault();
              commit();
              const first = section.points[0];
              if (first) setFocusKey(`p:${first.id}`);
              else newPending(section.id, { id: null });
            }}
            testId="outline-section-title"
          />
          {change && <ChangeBadge change={change.change} />}
          <span className="muted outline-count">{section.points.length || ''}</span>
          <RemoveButton label={`Remove section ${section.title} and its points`} testId="outline-remove-section" onRemove={() => void apply([{ op: 'removeSection', id: section.id }])} />
        </header>
        <WasLines change={change} />
        {!folded && (
          <>
            <ul className="outline-points">{nodes}</ul>
            <button className="ghost small link outline-add" onClick={() => newPending(section.id, { id: section.points.at(-1)?.id ?? null })} data-testid="outline-add-point">
              <PlusIcon /> Point
            </button>
          </>
        )}
      </section>
    );
  };

  const removedSectionBlock = (c: OutlineRowChange) => (
    <section key={`removed-${c.id}`} className="outline-section removed" data-change="removed" data-testid="outline-removed-section">
      <header className="outline-section-head">
        <s className="outline-removed-text">{c.was[0]}</s>
        <ChangeBadge change="removed" />
      </header>
      <ul className="outline-points">
        {removed('point')
          .filter((p) => p.section === c.id)
          .map((p) => (
            <RemovedPoint key={`removed-${p.id}`} change={p} />
          ))}
      </ul>
    </section>
  );

  return (
    <section className="editor outline-editor" ref={root} data-testid="outline-editor">
      <header className="outline-head">
        <div className="outline-head-main">
          <Field
            className="outline-title"
            label="Outline title"
            value={doc.title}
            required
            onCommit={(t) => {
              const title = t.replace(/\s+/g, ' ').trim();
              if (title && title !== doc.title) void apply([{ op: 'setMeta', title }]);
            }}
            onKey={(e) => e.key === 'Enter' && e.currentTarget.blur()}
            testId="outline-title"
          />
          <div className="outline-tabs" role="tablist" aria-label="Outline and target">
            <button role="tab" className="ghost" aria-selected="true" title={doc.path}>
              Outline
            </button>
            <button
              role="tab"
              className="ghost"
              aria-selected="false"
              disabled={!doc.target || !doc.targetExists}
              title={!doc.target ? 'No target yet. Generate picks one.' : doc.targetExists ? `Open ${doc.target}` : `${doc.target} is not written yet`}
              onClick={openTarget}
              data-testid="outline-open-target"
            >
              {targetName(doc)}
              {doc.targetExists && <ExternalIcon />}
            </button>
          </div>
        </div>
        <div className="outline-actions">
          <button className="ghost icon-button" title="Copy reference" aria-label="Copy reference" onClick={props.onCopyReference} data-testid="outline-copy-reference">
            <LinkIcon />
          </button>
          <button
            className="primary chip"
            disabled={!hasPoints}
            title={hasPoints ? `Claude writes ${doc.target ?? `the ${doc.kind}`} fresh from the outline` : 'Add a point first'}
            onClick={() => send((fresh) => ({ text: generatePrompt(fresh) }))}
            data-testid="outline-generate"
          >
            Generate {targetName(doc)}
          </button>
        </div>
      </header>
      {outline.error && (
        <p role="alert" className="outline-error" data-testid="outline-error">
          {outline.error}
        </p>
      )}
      {rowChanges.length > 0 && changed && (
        <div className="outline-changes" role="status" data-testid="outline-changes">
          <span>
            Claude changed {rowChanges.length} {rowChanges.length === 1 ? 'row' : 'rows'} · {clock(changed.at)}
          </span>
          <span className="spacer" />
          <button className="ghost small" onClick={showNextChange} data-testid="outline-changes-next">
            Next change
          </button>
          <button className="ghost small" title="Clear the marks. Later changes of Claude's are marked from here." onClick={() => void markReviewed().catch((err) => props.onError(`Could not clear the marks: ${cleanError(err)}`))} data-testid="outline-changes-reviewed">
            Mark reviewed
          </button>
        </div>
      )}
      {direction?.state === 'proposed' && (
        <div className="outline-direction" role="status" data-testid="outline-direction">
          <p className="outline-direction-head">{directionHeadline(doc)}</p>
          {direction.bullets.length > 0 && (
            <ul className="outline-direction-bullets">
              {direction.bullets.map((b, i) => (
                <li key={i}>{b}</li>
              ))}
            </ul>
          )}
          <p className="outline-direction-scope" data-testid="outline-direction-scope">
            {scopeLine(direction.scope, doc)}
          </p>
          {changes.shown.length > 0 && (
            <>
              <p className="muted outline-direction-label">Outline changes</p>
              <ul className="outline-direction-changes">
                {changes.shown.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
              {direction.changes.length > CHANGES_SHOWN && (
                <button className="ghost small link outline-direction-more" aria-expanded={allChanges} onClick={() => setAllChanges(!allChanges)} data-testid="outline-direction-more">
                  {allChanges ? 'Show fewer' : `Show ${changes.more} more`}
                </button>
              )}
            </>
          )}
          <div className="outline-direction-actions">
            <button className="primary chip" onClick={() => sendDirection(direction.scope)} data-testid="outline-accept">
              {ACCEPT_LABEL[direction.scope]}
            </button>
            <button
              className="ghost chip"
              title="Change the outline first, then accept"
              onClick={() => (root.current?.querySelector<FieldElement>('[data-row]') ?? root.current?.querySelector<HTMLInputElement>('.outline-section-title'))?.focus()}
              data-testid="outline-edit-direction"
            >
              Edit direction
            </button>
            {direction.scope !== 'edit' && (
              <button className="ghost chip" title="Accept, but have Claude edit passages in place" onClick={() => sendDirection('edit')} data-testid="outline-edit-in-place">
                Edit in place
              </button>
            )}
            <span className="spacer" />
            <button className="ghost small" title="Clear the direction without sending" onClick={() => void apply([{ op: 'clearDirection' }])} data-testid="outline-dismiss">
              Dismiss
            </button>
          </div>
        </div>
      )}
      {direction?.state === 'accepted' && (
        <p className="muted outline-accepted" data-testid="outline-direction-accepted">
          Direction accepted · {direction.scope}. Claude clears it once {targetName(doc)} is revised.
        </p>
      )}
      <div className="outline-work">
        <div className="outline-main">
          <div className="outline-meta">
            <label>
              <span>Target</span>
              <Field
                label="Target"
                placeholder={doc.kind === 'page' ? 'site/page.html' : 'docs/memo.md'}
                value={doc.target ?? ''}
                onCommit={(t) => void apply([{ op: 'setMeta', target: t.trim() || null }])}
                onKey={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                testId="outline-target"
              />
            </label>
            <span className="outline-kind" role="group" aria-label="Kind">
              {(['document', 'page'] as const).map((k) => (
                <button key={k} className={doc.kind === k ? 'ghost on' : 'ghost'} aria-pressed={doc.kind === k} onClick={() => doc.kind !== k && void apply([{ op: 'setMeta', kind: k }])} data-testid={`outline-kind-${k}`}>
                  {k === 'document' ? 'Document' : 'Page'}
                </button>
              ))}
            </span>
          </div>
          <dl className="outline-intent" aria-label="Intent">
            {intentRows(doc.intent).map((l) => (
              <div key={l.key} className="outline-intent-row" data-change={live.get(`intent:${l.key}`)?.change}>
                <dt>{l.key}</dt>
                <dd>
                  <Field
                    wrap
                    label={`Intent ${l.key}`}
                    placeholder={INTENT_HINTS[l.key]}
                    value={l.text}
                    onCommit={(t) =>
                      void apply(() => {
                        const op = intentOp(outline.current()?.intent ?? [], l.key, t);
                        return op ? [op] : [];
                      })
                    }
                    onKey={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                    testId={`outline-intent-${l.key.toLowerCase()}`}
                  />
                  <WasLines change={live.get(`intent:${l.key}`)} />
                </dd>
              </div>
            ))}
          </dl>
          {placeRemoved(doc.sections.map((sec) => ({ id: sec.id, node: sectionBlock(sec) })), removedSections, removedSectionBlock)}
          {addingSection ? (
            <div className="outline-section-head new">
              <Field
                className="outline-section-title"
                label="New section title"
                placeholder="Section title"
                value=""
                focus={focusKey === 'new-section'}
                onFocus={() => setFocusKey(undefined)}
                onCommit={addSection}
                onLeave={(t) => !t.trim() && setAddingSection(false)}
                onKey={(e, text, commit) => {
                  if (e.key === 'Escape') setAddingSection(false);
                  if (e.key !== 'Enter' || !text.trim()) return;
                  e.preventDefault();
                  enterSection.current = true;
                  commit();
                }}
                testId="outline-new-section"
              />
            </div>
          ) : (
            <button
              className="ghost small link outline-add"
              onClick={() => {
                setAddingSection(true);
                setFocusKey('new-section');
              }}
              data-testid="outline-add-section"
            >
              <PlusIcon /> Section
            </button>
          )}
          {!doc.sections.length && !addingSection && <p className="muted outline-empty">Add a section, or ask Claude to draft the outline.</p>}
        </div>
        <aside className="outline-rail" aria-label="Sources">
          <h3>Sources</h3>
          {!doc.sources.length && <p className="muted">No sources yet. A cite names one.</p>}
          {doc.sources.map((s) => (
            <SourceCard key={s.id} source={s} change={live.get(s.id)} highlighted={highlight === s.id} onSelect={() => setHighlight(highlight === s.id ? undefined : s.id)} onOpen={openRef} apply={apply} />
          ))}
          {removed('source').map((c) => (
            <div key={`removed-${c.id}`} className="outline-source removed" data-change="removed" data-testid="outline-removed-source">
              <div className="outline-source-head">
                <span className="outline-source-id">{c.id}</span>
                <s className="outline-removed-text">{c.was[0]}</s>
                <ChangeBadge change="removed" />
              </div>
            </div>
          ))}
          {addingSource ? (
            <NewSource
              onAdd={(title, ref) => {
                void apply([{ op: 'addSource', title, ...(ref ? { ref } : {}) }]);
                setAddingSource(false);
              }}
              onCancel={() => setAddingSource(false)}
            />
          ) : (
            <button className="ghost small link outline-add" onClick={() => setAddingSource(true)} data-testid="outline-add-source">
              <PlusIcon /> Add source
            </button>
          )}
          <div className="outline-ask">
            <label htmlFor="outline-ask">Ask Claude · {askTitle ?? 'whole outline'}</label>
            <textarea
              id="outline-ask"
              rows={3}
              placeholder={askTitle ? `Ask about ${askTitle}. Claude updates the outline only.` : 'Ask about the outline. Claude updates the outline only.'}
              value={ask}
              onChange={(e) => setAsk(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && e.metaKey && ask.trim()) {
                  e.preventDefault();
                  sendAsk();
                }
              }}
              data-testid="outline-ask"
            />
            <div className="outline-ask-actions">
              {askTitle && (
                <button className="ghost small" title="Ask about the whole outline" onClick={() => setAskSection(undefined)} data-testid="outline-ask-whole">
                  Whole outline
                </button>
              )}
              <span className="spacer" />
              <button className="primary chip" disabled={!ask.trim()} onClick={sendAsk} data-testid="outline-ask-send">
                Send <kbd>⌘↩</kbd>
              </button>
            </div>
          </div>
        </aside>
      </div>
    </section>
  );

  function sendAsk() {
    const words = ask;
    send((fresh) => ({ text: askPrompt(fresh, askSection, words), onSent: async () => setAsk('') }));
  }
}

const INTENT_HINTS: Record<string, string> = {
  Reader: 'Who reads it',
  Goal: 'What they should do or decide',
  Message: 'The one thing to take away',
  Guide: 'Tone and how to handle numbers',
};

function SourceCard(props: { source: OutlineSource; change?: OutlineRowChange; highlighted: boolean; onSelect: () => void; onOpen: (ref: string) => void; apply: OutlineDocState['apply'] }) {
  const { source: s, apply } = props;
  const ref = openableRef(s.ref) ? s.ref.trim() : undefined;
  const edit = (field: 'ref' | 'supports' | 'notShown') => (t: string) => void apply([{ op: 'editSource', id: s.id, [field]: t.trim() || null } as OutlineOp]);
  return (
    <div className={`outline-source${props.highlighted ? ' on' : ''}${props.change ? ` changed ${props.change.change}` : ''}`} data-source={s.id} data-change={props.change?.change} data-testid="outline-source">
      <div className="outline-source-head">
        <button className="ghost small outline-source-id" aria-pressed={props.highlighted} title="Highlight this source" onClick={props.onSelect}>
          {s.id}
        </button>
        <Field
          className="outline-source-title"
          label={`Title of ${s.id}`}
          value={s.title}
          required
          onCommit={(t) => t.trim() && t.trim() !== s.title && void apply([{ op: 'editSource', id: s.id, title: t.trim() }])}
          onKey={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        />
        {ref && (
          <button className="ghost icon-button small outline-source-open" aria-label={`Open ${s.id}`} title={`Open ${ref}`} onClick={() => props.onOpen(ref)} data-testid="outline-source-open">
            <ExternalIcon />
          </button>
        )}
        {props.change && <ChangeBadge change={props.change.change} />}
        <RemoveButton label={`Remove ${s.id} and the cites that name it`} testId="outline-remove-source" onRemove={() => void apply([{ op: 'removeSource', id: s.id }])} />
      </div>
      <WasLines change={props.change} />
      {s.checked && (
        <span className="outline-checked" data-testid="outline-source-checked">
          ✓ Checked {s.checked}
        </span>
      )}
      <Field className={s.ref ? 'outline-source-ref' : 'outline-source-ref empty'} label={`Ref of ${s.id}`} placeholder="Path or URL" value={s.ref ?? ''} onCommit={edit('ref')} />
      <label className={s.supports ? undefined : 'empty'}>
        <span>Supports</span>
        <Field label={`What ${s.id} supports`} placeholder="What it establishes" value={s.supports ?? ''} onCommit={edit('supports')} />
      </label>
      <label className={s.notShown ? undefined : 'empty'}>
        <span>Not shown</span>
        <Field label={`What ${s.id} does not show`} placeholder="What it does not establish" value={s.notShown ?? ''} onCommit={edit('notShown')} />
      </label>
    </div>
  );
}

function NewSource(props: { onAdd: (title: string, ref: string) => void; onCancel: () => void }) {
  const [title, setTitle] = useState('');
  const [ref, setRef] = useState('');
  const add = () => title.trim() && props.onAdd(title.trim(), ref.trim());
  const keys = (e: ReactKeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      add();
    }
    if (e.key === 'Escape') props.onCancel();
  };
  return (
    <div className="outline-source new" data-escape-owner>
      <input autoFocus aria-label="Source title" placeholder="Title, such as Pilot readout" value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={keys} data-testid="outline-source-new-title" />
      <input aria-label="Source ref" placeholder="Path or URL (optional)" value={ref} onChange={(e) => setRef(e.target.value)} onKeyDown={keys} data-testid="outline-source-new-ref" />
      <div className="outline-ask-actions">
        <button className="ghost small" onClick={props.onCancel}>
          Cancel
        </button>
        <span className="spacer" />
        <button className="primary chip" disabled={!title.trim()} onClick={add} data-testid="outline-source-new-add">
          Add
        </button>
      </div>
    </div>
  );
}
