import type { BehaviorDocument, BehaviorDecision } from '../protocol';
import { BehaviorPanel } from './BehaviorPanel';
import { FeedbackPanel, openCount, useFeedbackDoc, type FeedbackHost, type SendFeedback } from './FeedbackPanel';
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { CompanionApi, Draft } from '../shared/ipc';
import { anchorLabel, baseName, commentCount, type DraftReview, type ReviewAnchor, type ReviewComment, type ReviewRect } from '../shared/review';
import type { ReviewEdit, SelectedElement } from '../shared/review-edit';
import { isTagged, REVIEW_SOURCE, type FromPage, type PagePin, type ToPage } from '../review/messages';
import type { DraftBook } from './drafts';
import { newPictureId } from './editor/pictures';
import { useStore } from './hooks';
import { CommentIcon, ExternalIcon, PencilIcon, ReloadIcon, SidebarIcon, TrashIcon } from './Icons';
import { Inspector } from './Inspector';
import { OVERALL, type ReviewVoice } from './review-voice';
import { useItemWorkspace, WorkspaceLayer, type WorkspaceHost } from './WorkspaceLayer';
import type { WorkspaceSnapshot } from '../shared/feedback-workspace';

export type ReviewHost = FeedbackHost & WorkspaceHost & Pick<CompanionApi, 'readBehavior' | 'decideBehavior' | 'onBehaviorChanged' | 'reviewUrl' | 'reviewEdit' | 'reviewUndo' | 'reviewRedo' | 'capturePanel' | 'openLink' | 'openOutputElsewhere'>;

export type ReviewDraft = Draft & { review: DraftReview };

/** A draft keeps 40 pictures. Pins past this many go without one. */
const MAX_PICTURES = 36;
/** Room around an element's crop. */
const CROP_PAD = 12;
/** How long a page has to answer before the pane says it cannot add pins. */
const READY_WAIT_MS = 2000;
/** How long the page has to measure an element for a workspace snapshot. */
const MEASURE_WAIT_MS = 1500;
/** How long a workspace capture waits for the page to load. */
const PAGE_WAIT_MS = 8000;

const newCommentId = () => `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const editable = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || t.matches('input, textarea, select'));

/** The part of `view`, padded, that lies inside the frame, in window pixels. */
function cropRect(frame: DOMRect, view: ReviewRect): ReviewRect {
  const left = Math.max(frame.left, frame.left + view.x - CROP_PAD);
  const top = Math.max(frame.top, frame.top + view.y - CROP_PAD);
  const right = Math.min(frame.right, frame.left + view.x + view.width + CROP_PAD);
  const bottom = Math.min(frame.bottom, frame.top + view.y + view.height + CROP_PAD);
  return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

/**
 * Reviews a session's HTML file: the live page on the left, its pinned comments
 * on the right. Comment mode turns a click or a text selection into a pin, and
 * the mic sends what you say to the selected pin. Edit mode changes the page's
 * elements in place and saves each change to the file, with the inspector on the right.
 */
export function ReviewView(props: {
  host: ReviewHost;
  book: DraftBook;
  draft: ReviewDraft;
  voice: ReviewVoice;
  /** Whether the list beside the pane shows. The pane's first button hides or shows it. */
  listOpen: boolean;
  onToggleList: () => void;
  onSend: () => void;
  onSendFeedback: SendFeedback;
  /** The session runs, so Send decisions can reach it. */
  canSend: boolean;
  onError: (message: string) => void;
  /** Opens another output's feedback item, from the graph. */
  onOpenFeedbackItem?: (output: string, n: number) => void;
}) {
  const { book, draft, host } = props;
  const voice = useStore(props.voice);
  const { review } = draft;
  const [side, setSide] = useState<'comments' | 'behavior' | 'feedback'>('comments');
  const sideRef = useRef(side);
  sideRef.current = side;
  const feedback = useFeedbackDoc(host, draft.sessionId, review.path);
  const [behavior, setBehavior] = useState<BehaviorDocument>();
  const [behaviorError, setBehaviorError] = useState<string>();
  const behaviorRequest = useRef(0);
  const loadBehavior = useCallback(async () => {
    if (!draft.sessionId) return;
    const request = ++behaviorRequest.current;
    try {
      const doc = await host.readBehavior(draft.sessionId, review.path);
      if (request !== behaviorRequest.current) return;
      setBehavior(doc);
      setBehaviorError(undefined);
      book.setBehavior(draft.id, doc);
    } catch (err) { if (request === behaviorRequest.current) setBehaviorError((err as Error).message); }
  }, [host, book, draft.id, draft.sessionId, review.path]);
  useEffect(() => {
    setBehavior(undefined);
    void loadBehavior();
    const off = host.onBehaviorChanged(() => void loadBehavior());
    return () => { ++behaviorRequest.current; off(); };
  }, [loadBehavior, host]);
  const decideBehavior = useCallback(async (decision: BehaviorDecision) => {
    if (!draft.sessionId) return false;
    try {
      const doc = await host.decideBehavior(draft.sessionId, review.path, decision);
      ++behaviorRequest.current;
      setBehavior(doc);
      setBehaviorError(undefined);
      book.setBehavior(draft.id, doc);
      return true;
    } catch (err) {
      await loadBehavior();
      setBehaviorError((err as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
      return false;
    }
  }, [host, book, draft.id, draft.sessionId, review.path, loadBehavior]);
  const behaviorBusy = useCallback((busy: boolean) => {
    if (busy) book.behaviorEditing.add(draft.id);
    else book.behaviorEditing.delete(draft.id);
  }, [book, draft.id]);
  const frame = useRef<HTMLIFrameElement>(null);
  const [url, setUrl] = useState<string>();
  const [failed, setFailed] = useState<string>();
  const [loaded, setLoaded] = useState(false);
  const [silent, setSilent] = useState(false);
  const [reloads, setReloads] = useState(0);
  const [commenting, setCommentingState] = useState(review.comments.length === 0);
  const [editing, setEditingState] = useState(false);
  const [pageEditable, setPageEditable] = useState(false);
  const [selected, setSelected] = useState<SelectedElement | null>(null);
  // Comment and edit mode never run together.
  const setCommenting = useCallback((next: boolean | ((on: boolean) => boolean)) => {
    setCommentingState((on) => {
      const value = typeof next === 'function' ? next(on) : next;
      if (value) setEditingState(false);
      return value;
    });
  }, []);
  const setEditing = useCallback((next: boolean | ((on: boolean) => boolean)) => {
    setEditingState((on) => {
      const value = typeof next === 'function' ? next(on) : next;
      if (value) setCommentingState(false);
      if (!value) setSelected(null);
      return value;
    });
  }, []);
  const [activeId, setActiveId] = useState<string>();
  const [missing, setMissing] = useState<string[]>([]);
  const [pagePath, setPagePath] = useState<string>();
  const onPage = pagePath === undefined || pagePath === review.path;
  /** The feedback items on the element clicked last. */
  const [pointed, setPointed] = useState<number[]>();
  /** The feedback item the next pin joins. */
  const [picked, setPicked] = useState<number>();
  const items = feedback.doc?.items ?? [];

  // The latest values, for the message handler.
  const live = useRef({ draftId: draft.id, sessionId: draft.sessionId, path: review.path, commenting, editing, onPage, items, picked });
  live.current = { draftId: draft.id, sessionId: draft.sessionId, path: review.path, commenting, editing, onPage, items, picked };
  /** The items whose `Where:` is among the selectors an element matched. */
  const itemsAt = useCallback((matches: string[] = []) => live.current.items.filter((i) => i.where && matches.includes(i.where)).map((i) => i.n), []);

  useEffect(() => {
    if (!draft.sessionId) {
      setFailed('File this review under its session to open the page.');
      return;
    }
    let gone = false;
    host
      .reviewUrl(draft.sessionId, review.path)
      .then((u) => !gone && setUrl(u))
      .catch((err: Error) => !gone && setFailed(err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')));
    return () => {
      gone = true;
    };
  }, [host, draft.sessionId, review.path]);

  // Words start out meant for the overall note. Leaving the review closes the mic, and words already heard still land.
  useEffect(() => {
    props.voice.aim(OVERALL);
    return () => void props.voice.stop();
  }, [props.voice]);

  const post = useCallback((m: ToPage) => frame.current?.contentWindow?.postMessage({ source: REVIEW_SOURCE, ...m }, '*'), []);

  // The page's overlay says ready once it loads. A capture waits for that, so an early open still gets its picture.
  const ready = useRef(false);
  const readyWaiters = useRef(new Set<() => void>());
  const pageReady = useCallback(
    () =>
      new Promise<boolean>((resolve) => {
        if (ready.current) return resolve(true);
        const done = (ok: boolean) => {
          clearTimeout(timer);
          readyWaiters.current.delete(onReady);
          resolve(ok);
        };
        const onReady = () => done(true);
        const timer = setTimeout(() => done(false), PAGE_WAIT_MS);
        readyWaiters.current.add(onReady);
      }),
    [],
  );

  // Opening an item's workspace first crops its element from the page.
  const measures = useRef(new Map<string, (view?: ReviewRect) => void>());
  const capture = useCallback(
    async (selector: string): Promise<WorkspaceSnapshot | undefined> => {
      if (!(await pageReady()) || !live.current.onPage) return undefined;
      const id = newCommentId();
      const view = await new Promise<ReviewRect | undefined>((resolve) => {
        const timer = setTimeout(() => measures.current.get(id)?.(), MEASURE_WAIT_MS);
        measures.current.set(id, (v) => {
          clearTimeout(timer);
          measures.current.delete(id);
          resolve(v);
        });
        post({ type: 'measure', id, selector });
      });
      const box = frame.current?.getBoundingClientRect();
      if (!view || !box) return undefined;
      const rect = cropRect(box, view);
      const data = await host.capturePanel(rect);
      return data ? { data, width: rect.width, height: rect.height } : undefined;
    },
    [host, post, pageReady],
  );
  const workspace = useItemWorkspace({ host, sessionId: draft.sessionId, path: review.path, capture, onError: props.onError });
  const layerOpen = useRef(false);
  layerOpen.current = !!workspace.open;

  const select = useCallback(
    (id: string | undefined, focus = false) => {
      setActiveId(id);
      props.voice.aim(id ?? OVERALL);
      if (id && focus) requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(`[data-comment="${id}"] textarea`)?.focus());
      if (id) requestAnimationFrame(() => document.querySelector(`[data-comment="${id}"]`)?.scrollIntoView({ block: 'nearest' }));
    },
    [props.voice],
  );

  const reload = useCallback(() => {
    ready.current = false;
    setLoaded(false);
    setPagePath(undefined);
    setSelected(null);
    setReloads((n) => n + 1);
    void loadBehavior();
  }, [loadBehavior]);

  /** Saves one page edit and hands main's answer back to the page. A refused edit reloads the page. */
  const saveEdit = useCallback(
    async (version: string, edit: ReviewEdit) => {
      const { sessionId, path, draftId } = live.current;
      if (!sessionId) return;
      const result = await host.reviewEdit(sessionId, path, version, edit).catch((err: Error) => ({ ok: false as const, error: err.message }));
      post({ type: 'edited', result });
      if (result.ok) book.addEdit(draftId, result.summary);
      else {
        props.onError(result.error);
        reload();
      }
    },
    [host, book, post, reload, props.onError],
  );

  const history = useCallback(
    async (way: 'undo' | 'redo') => {
      const { sessionId, path, draftId } = live.current;
      if (!sessionId) return;
      const result = await (way === 'undo' ? host.reviewUndo(sessionId, path) : host.reviewRedo(sessionId, path)).catch((err: Error) => ({ ok: false as const, error: err.message }));
      if (!result.ok) {
        props.onError(result.error);
        return;
      }
      book.addEdit(draftId, result.summary);
      reload();
    },
    [host, book, reload, props.onError],
  );

  const addPin = useCallback(
    async (anchor: ReviewAnchor, view: ReviewRect, matches?: string[]) => {
      const box = frame.current?.getBoundingClientRect();
      const current = book.get(live.current.draftId);
      if (!box || !current?.review) return;
      // With feedback items, a pin joins the picked item, else the items on its element.
      const { picked } = live.current;
      const feedback = live.current.items.length ? (picked !== undefined ? [picked] : itemsAt(matches)) : undefined;
      setPicked(undefined);
      const room = Object.keys(current.attachments ?? {}).length < MAX_PICTURES;
      const picture = room ? await host.capturePanel(cropRect(box, view)).catch(() => undefined) : undefined;
      const comment: ReviewComment = { id: newCommentId(), text: '', anchor, createdAt: Date.now(), ...(picture ? { picture: newPictureId() } : {}), ...(feedback ? { feedback } : {}) };
      book.addComment(current.id, comment, picture);
      setSide('comments');
      select(comment.id, true);
    },
    [book, host, select, itemsAt],
  );

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow || !isTagged(e.data)) return;
      const m = e.data as unknown as FromPage;
      if (m.type === 'ready') {
        ready.current = true;
        for (const fn of [...readyWaiters.current]) fn();
        setLoaded(true);
        setSilent(false);
        setPagePath(m.path);
        setPageEditable(!!m.editable);
      }
      if (m.type === 'edit') void saveEdit(m.version, m.edit);
      if (m.type === 'selected') setSelected(m.element);
      if (m.type === 'reload') reload();
      if (m.type === 'key' && m.key === 'e') setEditing((on) => !on);
      if (m.type === 'key' && (m.key === 'undo' || m.key === 'redo')) void history(m.key);
      if (m.type === 'pin' && live.current.onPage) void addPin(m.anchor, m.view, m.matches);
      if (m.type === 'pointed') setPointed(itemsAt(m.matches));
      if (m.type === 'open-pin') select(m.id, true);
      if (m.type === 'behavior-missing') props.onError(sideRef.current === 'feedback' ? 'That element is not on the page now. Ask Claude to update the item\'s Where line.' : 'That element is not visible. Open the indicated prototype state, or ask the agent to update its target.');
      if (m.type === 'missing') setMissing(m.ids);
      if (m.type === 'measured') measures.current.get(m.id)?.(m.view);
      if (m.type === 'link') void host.openLink(m.href).catch(() => props.onError('Could not open that link.'));
      if (m.type === 'key' && m.key === 'c') setCommenting((on) => !on);
      if (m.type === 'key' && m.key === 'Escape') {
        setCommenting(false);
        setEditing(false);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [addPin, select, host, props.onError, saveEdit, reload, history, setCommenting, setEditing, itemsAt]);

  // The page reports clicks on elements that feedback items name.
  const wheres = JSON.stringify([...new Set(items.flatMap((i) => (i.where ? [i.where] : [])))]);
  useEffect(() => {
    if (loaded) post({ type: 'where', selectors: JSON.parse(wheres) as string[] });
  }, [loaded, wheres, post]);

  // C toggles comment mode, E edit mode, and Escape leaves either, unless a field has the keys.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      // The workspace board takes its own keys.
      if (editable(e.target) || layerOpen.current) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && live.current.editing) {
        e.preventDefault();
        void history(e.shiftKey ? 'redo' : 'undo');
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'c' || e.key === 'C') {
        e.preventDefault();
        setCommenting((on) => !on);
      }
      if (e.key === 'e' || e.key === 'E') {
        e.preventDefault();
        setEditing((on) => !on);
      }
      if (e.key === 'Escape' && live.current.commenting) setCommenting(false);
      if (e.key === 'Escape' && live.current.editing) setEditing(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [history, setCommenting, setEditing]);

  const pins: PagePin[] = onPage
    ? review.comments.map((c, i) => ({ id: c.id, n: i + 1, selector: c.anchor.selector, fx: c.anchor.fx, fy: c.anchor.fy, active: c.id === activeId }))
    : [];
  const pinKey = JSON.stringify(pins);
  useEffect(() => {
    if (loaded) post({ type: 'pins', pins });
  }, [loaded, pinKey, post]);
  useEffect(() => {
    if (loaded) post({ type: 'commenting', on: commenting && onPage });
  }, [loaded, commenting, onPage, post]);
  const isEditing = editing && onPage && pageEditable;
  useEffect(() => {
    if (loaded) post({ type: 'editing', on: isEditing });
  }, [loaded, isEditing, post]);
  const settled = useRef({ reloads, loaded });
  settled.current = { reloads, loaded };
  /** A page whose overlay never says hello blocks added scripts. */
  const onFrameLoad = () => {
    const at = reloads;
    setTimeout(() => {
      if (at === settled.current.reloads && !settled.current.loaded) setSilent(true);
    }, READY_WAIT_MS);
  };

  const openElsewhere = () => {
    if (draft.sessionId) void host.openOutputElsewhere(draft.sessionId, review.path).catch((err: Error) => props.onError(err.message));
  };
  const sendKeys = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && e.metaKey) {
      e.preventDefault();
      props.onSend();
    }
  };
  const remove = (id: string) => {
    book.removeComment(draft.id, id);
    if (activeId === id) select(undefined);
  };

  const src = url && (reloads ? `${url}?reload=${reloads}` : url);
  const count = review.comments.length;

  return (
    <div className="review" data-testid="review" data-escape-owner={commenting || isEditing ? '' : undefined}>
      <header className="review-bar">
        <button
          className="ghost icon-button"
          title={props.listOpen ? 'Hide the list' : 'Show the list'}
          aria-label={props.listOpen ? 'Hide the list' : 'Show the list'}
          aria-pressed={props.listOpen}
          onClick={props.onToggleList}
          data-testid="review-list-toggle"
        >
          <SidebarIcon />
        </button>
        <span className="review-title" title={review.path}>
          Review <span className="muted">· {baseName(review.path)}</span>
        </span>
        <span className="spacer" />
        <button
          className={commenting && onPage ? 'chip on' : 'chip'}
          aria-pressed={commenting && onPage}
          disabled={!onPage || silent}
          title={commenting ? 'Stop commenting (Esc)' : 'Click or select on the page to pin a comment (C)'}
          onClick={() => setCommenting((on) => !on)}
          data-testid="review-comment"
        >
          <CommentIcon /> Comment <kbd>C</kbd>
        </button>
        <button
          className={isEditing ? 'chip on' : 'chip'}
          aria-pressed={isEditing}
          disabled={!onPage || silent || !pageEditable}
          title={!pageEditable && loaded ? 'This page has no markup edit mode can change' : isEditing ? 'Stop editing (Esc)' : 'Select, move, resize and retype elements; each change saves to the file (E)'}
          onClick={() => setEditing((on) => !on)}
          data-testid="review-edit"
        >
          <PencilIcon /> Edit <kbd>E</kbd>
        </button>
        <button className="ghost icon-button" title="Reload the page" aria-label="Reload the page" onClick={reload} data-testid="review-reload">
          <ReloadIcon />
        </button>
        <button className="ghost icon-button" title="Open in the browser" aria-label="Open in the browser" onClick={openElsewhere} data-testid="review-external">
          <ExternalIcon />
        </button>
      </header>
      <div className={commenting && onPage ? 'review-page commenting' : isEditing ? 'review-page editing' : 'review-page'}>
        {src && (
          <iframe
            key={src}
            ref={frame}
            src={src}
            title={`Page under review: ${review.path}`}
            sandbox="allow-scripts allow-same-origin allow-forms"
            onLoad={onFrameLoad}
            data-testid="review-frame"
          />
        )}
        {failed && (
          <div className="review-message" data-testid="review-failed">
            <p>{failed}</p>
            <button className="ghost link" onClick={openElsewhere}>
              Open in the browser
            </button>
          </div>
        )}
        {!onPage && (
          <div className="review-banner" data-testid="review-elsewhere">
            Showing {pagePath}. Pins belong to {baseName(review.path)}.
            <button className="ghost link" onClick={reload}>
              Go back
            </button>
          </div>
        )}
        {silent && <div className="review-banner">This page blocks the script that adds pins. Comment in the overall note instead.</div>}
        {commenting && onPage && loaded && (
          <div className="review-hint" data-testid="review-hint">
            Click to pin · drag across text to quote · <kbd>Esc</kbd> to browse
          </div>
        )}
        {isEditing && loaded && !selected && (
          <div className="review-hint" data-testid="review-edit-hint">
            Click to select · drag to move · double-click to retype · <kbd>Esc</kbd> to browse
          </div>
        )}
      </div>
      {/* An item's workspace covers the page and the list beside it. */}
      {workspace.open && draft.sessionId && (
        <WorkspaceLayer
          key={workspace.open.board}
          host={host}
          sessionId={draft.sessionId}
          path={review.path}
          board={workspace.open.board}
          n={workspace.open.n}
          item={feedback.doc?.items.find((i) => i.n === workspace.open!.n)}
          onBack={workspace.close}
          onError={props.onError}
        />
      )}
      {isEditing ? (
        <Inspector
          selected={selected}
          edits={review.edits?.length ?? 0}
          onStyle={(set) => post({ type: 'style', set })}
          onText={(text) => post({ type: 'text', text })}
          onAct={(act) => post({ type: 'act', act })}
          onInsert={(what) => post({ type: 'insert', what })}
        />
      ) : (
        <aside className="review-notes" aria-label="Review details">
          <div className="behavior-tabs" role="tablist" aria-label="Review details">
            <button className={side === 'comments' ? 'chip on' : 'chip'} role="tab" aria-selected={side === 'comments'} onClick={() => setSide('comments')}>Comments</button>
            <button className={side === 'behavior' ? 'chip on' : 'chip'} role="tab" aria-selected={side === 'behavior'} data-testid="behavior-tab" onClick={() => { setSide('behavior'); setCommenting(false); void loadBehavior(); }}>Behavior{behavior?.rules.some((r) => r.status === 'proposed') ? ` · ${behavior.rules.filter((r) => r.status === 'proposed').length} open` : ''}</button>
            <button className={side === 'feedback' ? 'chip on' : 'chip'} role="tab" aria-selected={side === 'feedback'} data-testid="feedback-tab" onClick={() => { setSide('feedback'); setCommenting(false); feedback.refresh(); }}>Feedback{openCount(feedback.doc) ? ` · ${openCount(feedback.doc)} open` : ''}</button>
          </div>
          {side === 'feedback' ? <FeedbackPanel key={draft.id} host={host} sessionId={draft.sessionId} feedback={feedback} canSend={props.canSend} onSend={props.onSendFeedback} onError={props.onError} beforeRecord={() => props.voice.stop()} onShow={(selector) => post({ type: 'show-behavior', selector })} pointed={pointed} picked={picked} onPick={setPicked} onOpenItem={props.onOpenFeedbackItem} onWorkspace={(item) => { setCommenting(false); void workspace.openItem(item); }} workspaceOpening={workspace.opening} /> : side === 'behavior' ? <BehaviorPanel key={draft.id} doc={behavior} error={behaviorError} onRefresh={() => void loadBehavior()} onDecide={decideBehavior} onBusy={behaviorBusy} onShow={(selector) => post({ type: 'show-behavior', selector })} /> : <>

          <label className={activeId === undefined && voice.recording ? 'review-overall listening' : 'review-overall'}>
            <span className="section-head">Overall</span>
            <textarea
              placeholder="Anything about the page as a whole"
              value={draft.body}
              onChange={(e) => book.edit(draft.id, e.target.value)}
              onFocus={() => select(undefined)}
              onKeyDown={sendKeys}
              data-testid="review-overall"
            />
            <VoiceState voice={voice} target={OVERALL} />
          </label>
          <h3 className="section-head">
            Comments{count > 0 && <span className="count">{count}</span>}
          </h3>
          {count === 0 ? (
            <p className="muted review-empty" data-testid="review-empty">
              Click anything on the page to pin a comment, or turn on the mic and talk as you go.
            </p>
          ) : (
            <ol className="review-cards">
              {review.comments.map((c, i) => (
                <CommentCard
                  key={c.id}
                  comment={c}
                  n={i + 1}
                  active={c.id === activeId}
                  missing={missing.includes(c.id)}
                  voice={voice}
                  onSelect={() => {
                    select(c.id);
                    post({ type: 'show', id: c.id });
                  }}
                  onEdit={(text) => book.editComment(draft.id, c.id, text)}
                  onRemove={() => remove(c.id)}
                  onKeyDown={sendKeys}
                />
              ))}
            </ol>
          )}
          <footer className="muted review-foot">
            {count > 0 ? `${commentCount(count)} · ⌘↩ sends with pictures` : 'Send hands Claude each comment with a picture of its element.'}
          </footer>
          </>}
        </aside>
      )}
    </div>
  );
}

function CommentCard(props: {
  comment: ReviewComment;
  n: number;
  active: boolean;
  missing: boolean;
  voice: ReviewVoice;
  onSelect: () => void;
  onEdit: (text: string) => void;
  onRemove: () => void;
  onKeyDown: (e: KeyboardEvent) => void;
}) {
  const { comment: c } = props;
  const listening = props.voice.recording && props.voice.target === c.id;
  return (
    <li
      className={`review-card${props.active ? ' active' : ''}${listening ? ' listening' : ''}`}
      data-comment={c.id}
      data-testid="review-card"
      onClick={(e) => {
        if (!(e.target as HTMLElement).closest('button, textarea')) props.onSelect();
      }}
    >
      <div className="review-card-head">
        <button className="ghost pin-badge" title="Show it on the page" onClick={props.onSelect} data-testid="review-pin">
          {props.n}
        </button>
        <span className="review-anchor" title={c.anchor.selector}>
          {c.anchor.quote ? c.anchor.tag : anchorLabel(c.anchor, 40)}
        </span>
        {!!c.feedback?.length && (
          <span className="kind-tag" title="The feedback items this pin is about" data-testid="review-feedback">
            {c.feedback.map((n) => `#${n}`).join(' ')}
          </span>
        )}
        {props.missing && (
          <span className="review-missing" title="The page no longer has this element" data-testid="review-missing">
            Gone
          </span>
        )}
        <button className="ghost icon-button small" aria-label={`Delete comment ${props.n}`} title="Delete" onClick={props.onRemove} data-testid="review-delete">
          <TrashIcon />
        </button>
      </div>
      {c.anchor.quote && (
        <blockquote className="review-quote" data-testid="review-quote">
          {c.anchor.quote}
        </blockquote>
      )}
      <textarea
        placeholder={listening ? 'Listening…' : 'What should change here?'}
        value={c.text}
        rows={2}
        onChange={(e) => props.onEdit(e.target.value)}
        onFocus={props.onSelect}
        onKeyDown={props.onKeyDown}
        data-testid="review-text"
      />
      <VoiceState voice={props.voice} target={c.id} />
    </li>
  );
}

/** Says when the mic is on this target, or its words are still turning into text. */
export function VoiceState(props: { voice: ReviewVoice; target: string }) {
  const listening = props.voice.recording && props.voice.target === props.target;
  const pending = props.voice.pending.has(props.target);
  if (!listening && !pending) return null;
  return (
    <span className="voice-state muted" data-testid="review-voice-state">
      {listening && <span className="rec-dot" aria-hidden="true" />}
      {pending ? 'Writing down what you said…' : 'Listening'}
    </span>
  );
}
