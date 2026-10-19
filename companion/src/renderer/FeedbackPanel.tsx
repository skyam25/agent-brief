/**
 * Feedback items for one output: grouped by the round they first came up in,
 * newest round on top. Cards show compact, and one at a time opens in full.
 * Each decision, note and voice note saves to the file at once as a dated You line.
 * While the panel shows, the footer Send hands Claude what you said and saved since the last send.
 * On a page, a click lists the items on that element, and a picked item ties the next pin to it.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type MouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { FeedbackDocument, FeedbackFileSummary, FeedbackItem, FeedbackOp } from '../protocol';
import { decisionsPrompt, pendingDecisions, quoted, receiptBatches, type PendingDecision } from '../shared/feedback';
import { workspaceSummary } from '../shared/feedback-workspace';
import type { CompanionApi } from '../shared/ipc';
import { BeforeAfter, type PictureHost } from './BeforeAfter';
import { claimDecisions } from './decisions-send';
import { decisionText, historyLines, inOpenFilter, isClosed, latestSaid, markSeen, needsLook, seenCount, updatedSince, type FeedbackFilter } from './feedback-cards';
import { FeedbackGraph } from './FeedbackGraph';
import { ExternalIcon, MicIcon, ReloadIcon } from './Icons';
import { useOutputWatch, type OutputWatchHost } from './output-watch';
import { ReviewVoice } from './review-voice';
import { claimTalk } from './talk-owner';
import { VoiceState } from './ReviewView';
import type { FixedSend } from './useSend';
import { useItemWorkspace, WorkspaceLayer, type WorkspaceHost } from './WorkspaceLayer';

export type FeedbackHost = Pick<CompanionApi, 'readFeedback' | 'updateFeedback' | 'listFeedback' | 'onFeedbackChanged' | 'transcribeClip' | 'requestMicrophone' | 'onVisibility' | 'openItemOutput'> & PictureHost;

/** Hands Claude what `build` makes. `build` gives a reason instead when there is nothing to send. */
export type SendFeedback = (sessionId: string, build: () => Promise<FixedSend | string>) => void;

const cleanError = (err: unknown) => (err as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

export interface FeedbackDocState {
  doc?: FeedbackDocument;
  error?: string;
  refresh: () => void;
  /** Reads the file again and gives the document, or undefined when the read failed. */
  reload: () => Promise<FeedbackDocument | undefined>;
  /** Applies ops as the user. Ops only add, so a stale version reads the file again and retries once. */
  apply: (ops: FeedbackOp[]) => Promise<boolean>;
}

/** An output's feedback document, kept current with every store write. */
export function useFeedbackDoc(host: FeedbackHost, sessionId: string | undefined, path: string): FeedbackDocState {
  const [doc, setDoc] = useState<FeedbackDocument>();
  const [error, setError] = useState<string>();
  const request = useRef(0);
  const live = useRef(doc);
  live.current = doc;
  const load = useCallback(async () => {
    if (!sessionId) return undefined;
    const n = ++request.current;
    try {
      const next = await host.readFeedback(sessionId, path);
      if (n === request.current) {
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
    setDoc(undefined);
    void load();
    const off = host.onFeedbackChanged(() => void load());
    return () => {
      ++request.current;
      off();
    };
  }, [load, host]);
  const apply = useCallback(
    async (ops: FeedbackOp[]) => {
      if (!sessionId) return false;
      for (let attempt = 0; attempt < 2; attempt++) {
        const current = attempt === 0 && live.current ? live.current : await load();
        if (!current) return false;
        try {
          const next = await host.updateFeedback(sessionId, path, { version: current.version, ops });
          ++request.current;
          setDoc(next);
          setError(undefined);
          return true;
        } catch (err) {
          if (attempt === 1 || !/changed since/.test(cleanError(err))) {
            setError(cleanError(err));
            return false;
          }
        }
      }
      return false;
    },
    [host, sessionId, path, load],
  );
  return { doc, error, refresh: () => void load(), reload: load, apply };
}

/** The project's feedback files, by output path, for the outputs list. */
export function useFeedbackFiles(host: FeedbackHost, sessionId: string | undefined): Map<string, FeedbackFileSummary> {
  const [files, setFiles] = useState(new Map<string, FeedbackFileSummary>());
  useEffect(() => {
    setFiles(new Map());
    if (!sessionId) return;
    let gone = false;
    const load = () =>
      void host
        .listFeedback(sessionId)
        .then((p) => !gone && setFiles(new Map(p.files.map((f) => [f.output, f]))))
        .catch(() => undefined);
    load();
    const off = host.onFeedbackChanged(load);
    return () => {
      gone = true;
      off();
    };
  }, [host, sessionId]);
  return files;
}

/** Items that wait on the user: open ones and closed ones raised again. */
export const openCount = (doc?: FeedbackDocument) => doc?.items.filter(needsLook).length ?? 0;

const STATE_LABELS: Record<FeedbackItem['state'], string> = { open: 'Open', accepted: 'Accepted', rejected: 'Rejected', done: 'Done' };

export function FeedbackPanel(props: {
  host: FeedbackHost;
  sessionId?: string;
  feedback: FeedbackDocState;
  /** Highlights an item's `Where:` on the page. Absent where no page shows. */
  onShow?: (selector: string) => void;
  onSend: SendFeedback;
  /** False when the session has ended, so nothing can be sent. */
  canSend: boolean;
  /** Runs before an item's mic opens, so only one recording holds the microphone. */
  beforeRecord?: () => Promise<void>;
  onError: (message: string) => void;
  /** Opens an item's workspace layer. Absent where no layer can show. */
  onWorkspace?: (item: FeedbackItem) => void;
  /** The item whose workspace is opening. */
  workspaceOpening?: number;
  /** The item to open and scroll to when the panel opens. */
  focus?: number;
  /** Opens an item of another output, from the graph. */
  onOpenItem?: (output: string, n: number) => void;
  /** The items on the page element clicked last. Absent until a click. */
  pointed?: number[];
  /** The item the next review pin joins. */
  picked?: number;
  onPick?: (n: number | undefined) => void;
  /** Draws the graph in place of the list. Otherwise it covers the review page as a layer. */
  inlineGraph?: boolean;
}) {
  const { doc, error, apply } = props.feedback;
  const [graphShown, setGraphShown] = useState(false);
  /** Bumps on Refresh, so the graph reads the files again too. */
  const [graphReads, setGraphReads] = useState(0);
  const [filter, setFilter] = useState<FeedbackFilter>('open');
  /** The one card shown in full. */
  const [expanded, setExpanded] = useState(props.focus);
  /** Items decided here stay listed under Open until the view closes. */
  const [kept, setKept] = useState(() => new Set<number>());
  const root = useRef<HTMLElement>(null);
  const graphInline = graphShown && !!props.inlineGraph;
  useEffect(() => {
    if (graphShown || expanded === undefined || !doc) return;
    root.current?.querySelector(`[data-testid="feedback-item-${expanded}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [graphShown, expanded, doc?.path]);
  const expandedItem = doc?.items.find((i) => i.n === expanded);
  // A pick lasts while its card stays open and the item stays open.
  const pickedItem = doc?.items.find((i) => i.n === props.picked);
  useEffect(() => {
    if (props.picked === undefined || !doc) return;
    if (expanded !== props.picked || !pickedItem || pickedItem.state === 'done' || pickedItem.state === 'rejected') props.onPick?.(undefined);
  }, [props.picked, expanded, pickedItem?.state, doc?.path]);
  // An open card counts as seen, along with whatever Claude writes while it is open.
  useEffect(() => {
    if (doc && expandedItem) markSeen(doc.path, expandedItem);
  }, [doc?.path, expandedItem?.events.length]);
  const openItem = (output: string, n: number) => {
    if (doc && output !== doc.output) return props.onOpenItem?.(output, n);
    setGraphShown(false);
    setExpanded(n);
  };
  /** Marks an item, so the next pin on the page joins it. */
  const pick = (n: number) => {
    openItem(doc?.output ?? '', n);
    props.onPick?.(n);
  };
  const keep = (n: number) => setKept((k) => (k.has(n) ? k : new Set(k).add(n)));
  const sources = new Map((doc?.rounds ?? []).flatMap((r) => (r.source ? [[r.n, r.source] as const] : [])));
  const openSource = (path: string) => {
    if (props.sessionId) void props.host.openItemOutput(props.sessionId, path).catch((err: Error) => props.onError(`Could not open ${path}: ${cleanError(err)}`));
  };
  const applyRef = useRef(apply);
  applyRef.current = apply;
  /** Notes typed but not yet saved, by item. Send saves them first. */
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const setDraft = (n: number, text: string) => setDrafts((d) => ({ ...d, [n]: text }));
  /** Voice lines still being written to the file. */
  const writes = useRef(new Set<Promise<boolean>>());
  const [voice] = useState(
    () =>
      new ReviewVoice({
        transcribe: (clip) => props.host.transcribeClip(clip),
        onText: (target, text) => {
          const write = applyRef.current([{ op: 'append', item: Number(target), key: 'You', text: `voice · ${oneLine(text)}` }]);
          writes.current.add(write);
          void write.finally(() => writes.current.delete(write));
        },
        onError: (message) => props.onError(message),
      }),
  );
  useSyncExternalStore(
    (fn) => voice.subscribe(fn),
    () => voice.version,
  );
  // The mic closes when the panel hides or this view goes, and words already heard still land.
  useEffect(() => {
    const off = props.host.onVisibility((visible) => !visible && void voice.stop());
    return () => {
      if (typeof off === 'function') off();
      void voice.stop();
    };
  }, [voice, props.host]);

  // While an item records, ⌥T stops it rather than starting the review mic.
  const recording = voice.recording;
  useEffect(() => (recording ? claimTalk(() => void voice.stop()) : undefined), [recording, voice]);

  // One mic for the panel. Pressing another item's mic moves the words there.
  const toggleVoice = async (n: number) => {
    const target = String(n);
    if (voice.recording) {
      if (voice.target === target) await voice.stop();
      else voice.aim(target);
      return;
    }
    await props.beforeRecord?.();
    const access = await props.host.requestMicrophone();
    if (!access.granted) {
      props.onError('Microphone access is off. Turn it on in System Settings > Privacy & Security > Microphone, then try again.');
      return;
    }
    await voice.start(target).catch((err: Error) => props.onError(`Could not start the microphone: ${err.message}`));
  };

  const pending = doc ? pendingDecisions(doc) : [];
  /** Items with a decision or a typed note waiting to go. */
  const waiting = new Set([...pending.map((p) => p.item.n), ...Object.keys(drafts).filter((n) => oneLine(drafts[Number(n)]!)).map(Number)]).size;
  /** Writes a receipt on each item through the last event sent. Throws naming the items left unmarked. */
  const markSent = async (sent: PendingDecision[]) => {
    const unmarked: string[] = [];
    for (const ops of receiptBatches(sent)) {
      if (!(await applyRef.current(ops))) unmarked.push(...ops.map((o) => (o.op === 'append' ? `#${o.item}` : '')));
    }
    if (unmarked.length) throw new Error(`the file was not marked for ${unmarked.join(', ')}. The next Send repeats them.`);
  };
  const send = () => {
    if (!props.sessionId || !waiting) return;
    props.onSend(props.sessionId, async () => {
      // Typed notes and words still turning into text reach the file before the send reads it.
      await voice.stop();
      await Promise.all([...writes.current]);
      const typed = Object.entries(draftsRef.current).flatMap(([n, text]) => (oneLine(text) ? [{ op: 'append' as const, item: Number(n), key: 'You', text: decisionText('note', undefined, oneLine(text)) }] : []));
      if (typed.length) {
        if (!(await applyRef.current(typed))) return 'Could not save your typed notes. Nothing was sent.';
        setDrafts({});
      }
      const fresh = await props.feedback.reload();
      if (!fresh) return 'Could not read the feedback file. Nothing was sent.';
      const now = pendingDecisions(fresh);
      if (!now.length) return 'Decide something first.';
      return { text: decisionsPrompt(fresh, now), onSent: () => markSent(now) };
    });
  };

  const items = doc?.items ?? [];
  // A feedback file whose output is gone reads, but takes no writes.
  const readOnly = doc?.outputExists === false;

  // The footer Send sends these decisions while the panel shows.
  const sendRef = useRef(send);
  sendRef.current = send;
  const blocked = readOnly ? 'This feedback is read-only, since its output is gone.' : !props.canSend ? 'This session has ended. Resume it to send.' : undefined;
  useEffect(() => claimDecisions({ count: waiting, blocked, send: () => sendRef.current() }), [waiting, blocked]);

  const rounds = [...(doc?.rounds ?? [])].sort((a, b) => b.n - a.n);
  const known = new Set(rounds.map((r) => r.n));
  const loose = items.filter((i) => i.round === undefined || !known.has(i.round));
  const listed = (i: FeedbackItem) => filter === 'all' || inOpenFilter(i) || i.n === expanded || kept.has(i.n);
  const showItem = (item: FeedbackItem) =>
    props.onShow &&
    ((selector: string) => {
      props.onShow!(selector);
      props.onPick?.(item.n);
      setExpanded(item.n);
    });
  const sourceOf = (item: FeedbackItem) => {
    const src = item.sources[0];
    return src && sources.get(src.round);
  };
  const card = (item: FeedbackItem) => (
    <ItemCard
      key={item.n}
      item={item}
      voice={voice}
      onApply={async (ops) => {
        keep(item.n);
        return apply(ops);
      }}
      expanded={item.n === expanded}
      onExpand={(open) => setExpanded(open ? item.n : undefined)}
      note={drafts[item.n] ?? ''}
      onNote={(text) => setDraft(item.n, text)}
      updated={!!doc && item.n !== expanded && updatedSince(item, seenCount(doc.path, item.n))}
      onShow={readOnly ? undefined : showItem(item)}
      onVoice={() => void toggleVoice(item.n)}
      pictures={doc && <BeforeAfter host={props.host} sessionId={props.sessionId} output={doc.output} item={item} />}
      focused={item.n === props.picked}
      onWorkspace={readOnly ? undefined : props.onWorkspace}
      opening={props.workspaceOpening === item.n}
      source={sourceOf(item)}
      onSource={openSource}
      readOnly={readOnly}
    />
  );

  const refresh = () => {
    props.feedback.refresh();
    setGraphReads((n) => n + 1);
  };
  const graph = graphShown && <FeedbackGraph host={props.host} sessionId={props.sessionId} output={doc?.output} reads={graphReads} onOpenItem={openItem} />;
  // On a review page the graph covers the page and this panel, under the review bar.
  const layerHost = graphShown && !props.inlineGraph ? root.current?.closest('.review') : undefined;

  return (
    <section className="feedback-panel" aria-label="Feedback" data-testid="feedback-panel" ref={root}>
      <div className="behavior-heading">
        <h3>Feedback{items.length > 0 ? ` · ${openCount(doc)} open` : ''}</h3>
        <span className="feedback-heading-actions">
          <span className="feedback-filter" role="group" aria-label="Show">
            {(['open', 'all'] as const).map((f) => (
              <button key={f} className={filter === f ? 'ghost on' : 'ghost'} aria-pressed={filter === f} onClick={() => setFilter(f)} data-testid={`feedback-filter-${f}`}>
                {f === 'open' ? 'Open' : 'All'}
              </button>
            ))}
          </span>
          <button className="ghost" aria-pressed={graphShown} title="How this project's sources, items, outputs and workspaces link" onClick={() => setGraphShown(!graphShown)} data-testid="feedback-graph-toggle">
            Graph
          </button>
          <button
            className="ghost icon-button small"
            title="Read the feedback files again"
            aria-label="Refresh"
            onClick={refresh}
            data-testid="feedback-refresh"
          >
            <ReloadIcon />
          </button>
        </span>
      </div>
      {doc && <p className="muted feedback-path" title={doc.path}>{doc.path}</p>}
      {error && <p role="alert" className="behavior-error">{error}</p>}
      {readOnly && (
        <p className="muted" data-testid="feedback-orphan">
          {doc.output} is gone, so its feedback is read-only.
        </p>
      )}
      {!doc && !error && <p>Loading feedback…</p>}
      {graphInline && graph}
      {layerHost &&
        createPortal(
          <section className="feedback-graph-layer" aria-label="Feedback graph" data-testid="feedback-graph-layer">
            <header className="workspace-head">
              <span className="workspace-title">Feedback graph</span>
              <span className="muted">Sources, items, outputs and workspaces across the project</span>
              <span className="spacer" />
              <button className="ghost icon-button small" title="Read the feedback files again" aria-label="Refresh" onClick={refresh} data-testid="feedback-graph-refresh">
                <ReloadIcon />
              </button>
              <button className="ghost" onClick={() => setGraphShown(false)} data-testid="feedback-graph-back">
                Back to list
              </button>
            </header>
            <div className="feedback-graph-body">{graph}</div>
          </section>,
          layerHost,
        )}
      {!graphInline && props.onPick && items.length > 0 && (props.pointed || props.picked !== undefined) && (
        <div className="feedback-pointed" data-testid="feedback-pointed">
          {props.picked !== undefined ? (
            <span>
              Your next pin joins #{props.picked}.{' '}
              <button className="ghost link" onClick={() => props.onPick!(undefined)} data-testid="feedback-unpick">
                Clear
              </button>
            </span>
          ) : props.pointed!.length ? (
            <>
              <span className="muted">On this element</span>
              {props.pointed!.map((n) => (
                <button key={n} className="chip" onClick={() => pick(n)} data-testid={`feedback-pointed-${n}`}>
                  #{n} {items.find((i) => i.n === n)?.title}
                </button>
              ))}
            </>
          ) : (
            <span className="muted">No feedback items on this element.</span>
          )}
        </div>
      )}
      {!graphInline && doc && !items.length && (
        <p className="muted" data-testid="feedback-empty">
          No feedback yet. Hand Claude a transcript and ask it to catalog the points against this output.
        </p>
      )}
      {!graphInline &&
        rounds.map((r) => {
          const group = items.filter((i) => i.round === r.n);
          if (!group.length) return null;
          const shown = group.filter(listed);
          const hidden = group.length - shown.length;
          // Under Open, a round with nothing left to decide folds to one line.
          if (!shown.length) {
            return (
              <button key={r.n} className="ghost feedback-round-folded" title="Show every item" onClick={() => setFilter('all')} data-testid={`feedback-round-${r.n}`}>
                Round {r.n} · {r.label}
                <span className="muted">
                  {' '}
                  · {r.date} · {hidden} closed
                </span>
              </button>
            );
          }
          return (
            <div key={r.n} className="feedback-round" data-testid={`feedback-round-${r.n}`}>
              <h4 className="section-head" title={r.source}>
                Round {r.n} · {r.label}
                <span className="muted">
                  {' '}
                  · {r.date}
                  {hidden ? ` · ${hidden} closed` : ''}
                </span>
              </h4>
              <ol className="review-cards">{shown.map(card)}</ol>
            </div>
          );
        })}
      {!graphInline && loose.some(listed) && <ol className="review-cards">{loose.filter(listed).map(card)}</ol>}
    </section>
  );
}

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

/** Clicks on a card's controls do not open or close it. */
const onControl = (e: MouseEvent) => !!(e.target as HTMLElement).closest('button, input, select, textarea, a, summary, .before-after');

function ItemCard(props: {
  item: FeedbackItem;
  voice: ReviewVoice;
  onApply: (ops: FeedbackOp[]) => Promise<boolean>;
  /** Shows the whole card. Otherwise it shows compact. */
  expanded: boolean;
  onExpand: (open: boolean) => void;
  /** The note being typed, kept by the panel so Send can save it. */
  note: string;
  onNote: (text: string) => void;
  /** Claude wrote since you last opened the card. */
  updated: boolean;
  onShow?: (selector: string) => void;
  onVoice: () => void;
  onWorkspace?: (item: FeedbackItem) => void;
  opening?: boolean;
  /** The item's before and after pictures. */
  pictures?: ReactNode;
  /** The next pin joins this item. */
  focused?: boolean;
  /** The transcript of the first quote's round, when it names one. */
  source?: string;
  onSource?: (path: string) => void;
  /** Shows the item without its decision, note and voice controls. */
  readOnly?: boolean;
}) {
  const { item, expanded } = props;
  const workspace = workspaceSummary(item);
  const { note, onNote: setNote } = props;
  const [saving, setSaving] = useState(false);
  /** The option the next Accept picks. */
  const [option, setOption] = useState(item.chosen);
  const listening = props.voice.recording && props.voice.target === String(item.n);
  const [first, ...later] = item.rounds;
  const src = item.sources[0];
  const closed = isClosed(item);
  const options = item.options ?? [];
  const say = async (verb: 'accept' | 'reject' | 'reopen' | 'note') => {
    const detail = oneLine(note);
    if (verb === 'note' && !detail) return;
    // An item with options opens to have one picked before an accept.
    if (verb === 'accept' && options.length && !option) return props.onExpand(true);
    setSaving(true);
    const ok = await props.onApply([{ op: 'append', item: item.n, key: 'You', text: decisionText(verb, verb === 'accept' ? option : undefined, detail) }]);
    setSaving(false);
    if (ok) setNote('');
  };
  const history = historyLines(item);
  // A bare accept or reject repeats the state chip, so only a note, option or reason shows.
  const said = latestSaid(item);
  const saidText = said?.detail;
  const acceptable = item.state !== 'accepted' || (!!option && option !== item.chosen) || !!oneLine(note);

  const actions = !props.readOnly && (
    <div className="behavior-actions">
      {closed ? (
        <button className="chip" disabled={saving} onClick={() => void say('reopen')} data-testid="feedback-reopen">
          Reopen
        </button>
      ) : (
        <>
          <button className={item.state === 'accepted' ? 'chip on' : 'chip'} aria-pressed={item.state === 'accepted'} disabled={saving} onClick={() => acceptable && void say('accept')} data-testid="feedback-accept">
            {option && expanded ? `Accept ${option}` : 'Accept'}
          </button>
          <button className="chip" disabled={saving} onClick={() => void say('reject')} data-testid="feedback-reject">
            Reject
          </button>
          {item.state === 'accepted' && (
            <button className="ghost" disabled={saving} onClick={() => void say('reopen')} data-testid="feedback-reopen">
              Reopen
            </button>
          )}
        </>
      )}
    </div>
  );

  return (
    <li
      className={`review-card feedback-item ${item.state}${expanded ? ' expanded' : ' compact'}${listening ? ' listening' : ''}${props.focused ? ' focused' : ''}`}
      onClick={(e) => !expanded && !onControl(e) && props.onExpand(true)}
      data-testid={`feedback-item-${item.n}`}
    >
      <button className="ghost review-card-head feedback-head" aria-expanded={expanded} title={expanded ? 'Show less' : 'Show the whole item'} onClick={() => props.onExpand(!expanded)} data-testid="feedback-expand">
        <span className="num">#{item.n}</span>
        <span className="feedback-title">{item.title}</span>
        {props.updated && (
          <span className="feedback-updated" title="Claude wrote since you last opened this" data-testid="feedback-updated">
            Updated
          </span>
        )}
      </button>
      <div className="feedback-badges">
        <span className={`feedback-state ${item.state}`} data-testid="feedback-state">
          {STATE_LABELS[item.state]}
        </span>
        {first !== undefined && <span className="kind-tag">Round {first}</span>}
        {later.map((n) => (
          <span key={n} className="kind-tag also" data-testid="feedback-also">
            also round {n}
          </span>
        ))}
        {item.revised && (
          <span className="kind-tag raised" title="The proposal changed after you accepted it. Decide again." data-testid="feedback-revised">
            Changed since you accepted
          </span>
        )}
        {item.raisedAgain !== undefined && (
          <span className="kind-tag raised" data-testid="feedback-raised">
            Raised again · round {item.raisedAgain}
          </span>
        )}
      </div>
      {src && !expanded && (
        <p className="feedback-quote-line" title={src.quote} data-testid="feedback-quote-line">
          {quoted(src.quote)}{src.speaker && <span className="muted"> — {src.speaker}</span>}
        </p>
      )}
      {src && expanded && (
        <blockquote className="review-quote">
          {src.quote}
          {src.speaker && (
            <span className="muted">
              {' '}
              — {src.speaker}
              {src.time && src.time !== '-' && props.source && props.onSource ? (
                <>
                  {' · '}
                  <button className="ghost link" title={`Open ${props.source}`} onClick={() => props.onSource!(props.source!)} data-testid="feedback-source">
                    {src.time}
                  </button>
                </>
              ) : src.time ? (
                ` · ${src.time}`
              ) : (
                ''
              )}
            </span>
          )}
        </blockquote>
      )}
      {expanded && item.change && <p className="feedback-change">{item.change}</p>}
      {expanded && options.length > 0 && (
        <div className="feedback-options" role="radiogroup" aria-label={`Options for #${item.n}`}>
          {options.map((o) => (
            <button
              key={o.key}
              role="radio"
              aria-checked={option === o.key}
              className={option === o.key ? 'feedback-option on' : 'feedback-option'}
              disabled={props.readOnly || closed}
              onClick={() => setOption(o.key)}
              data-testid={`feedback-option-${o.key}`}
            >
              <span className="key">{o.key}</span>
              <span>{o.text}</span>
            </button>
          ))}
        </div>
      )}
      {expanded && item.where && !closed && (
        <p className="muted feedback-where">
          {props.onShow ? (
            <button className="ghost link" onClick={() => props.onShow!(item.where!)} data-testid="feedback-show">
              Show on page
            </button>
          ) : (
            <>Where · {item.where}</>
          )}
        </p>
      )}
      {expanded && props.pictures}
      {expanded && ((props.onWorkspace && !closed) || workspace) && (
        <div className="feedback-workspace">
          {props.onWorkspace && !closed && (
            <button className="chip" disabled={props.opening} onClick={() => props.onWorkspace!(item)} data-testid="feedback-workspace-open">
              {props.opening ? 'Opening…' : 'Open workspace'}
            </button>
          )}
          {workspace && (
            <span className="muted" data-testid="feedback-workspace-summary">
              {workspace}
            </span>
          )}
        </div>
      )}
      {said && saidText && (
        <p className="feedback-said" data-testid="feedback-said">
          <span className="who">You</span>
          {[said.verb, saidText].join(' · ')}
        </p>
      )}
      {actions}
      {expanded && !props.readOnly && !closed && (
        <>
          <div className="feedback-note">
            <input
              aria-label={`Note on #${item.n}`}
              placeholder={listening ? 'Listening…' : 'Note or reason'}
              value={note}
              maxLength={2000}
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void say('note');
                }
              }}
              data-testid="feedback-note"
            />
            <button
              className={listening ? 'ghost icon-button small on' : 'ghost icon-button small'}
              aria-pressed={listening}
              aria-label={listening ? `Stop the voice note on #${item.n}` : `Record a voice note on #${item.n}`}
              title={listening ? 'Stop' : 'Record a voice note'}
              onClick={props.onVoice}
              data-testid="feedback-voice"
            >
              <MicIcon />
            </button>
          </div>
          <VoiceState voice={props.voice} target={String(item.n)} />
        </>
      )}
      {expanded && history.length > 0 && (
        <details className="feedback-history">
          <summary className="muted">History · {history.length}</summary>
          {history.map((l, i) => (
            <p key={i} className={`item-line ${l.key === 'You' ? 'you' : ''}`} data-testid="feedback-line">
              {l.key && <span className="who">{l.key}</span>}
              {l.text}
            </p>
          ))}
        </details>
      )}
    </li>
  );
}

/** The Feedback view for an output with no page to show, full width beside the list. */
export function FeedbackView(props: {
  host: FeedbackHost & WorkspaceHost & OutputWatchHost;
  sessionId: string;
  path: string;
  canSend: boolean;
  onSend: SendFeedback;
  onOpenFile: () => void;
  onError: (message: string) => void;
  focus?: number;
  onOpenItem?: (output: string, n: number) => void;
}) {
  const feedback = useFeedbackDoc(props.host, props.sessionId, props.path);
  useOutputWatch(props.host, props.sessionId, props.path);
  const gone = feedback.doc?.outputExists === false;
  const workspace = useItemWorkspace({ host: props.host, sessionId: props.sessionId, path: props.path, onError: props.onError });
  const open = workspace.open;
  return (
    <div className="items feedback-view" data-testid="feedback-view">
      <header className="items-head">
        <div className="items-title">
          <span className="title">{props.path.split('/').at(-1)}</span>
          <span className="muted path" title={props.path}>
            {props.path}
          </span>
        </div>
        {!gone && (
          <button className="ghost" onClick={props.onOpenFile} data-testid="feedback-open-file">
            <ExternalIcon /> Open file
          </button>
        )}
      </header>
      <div className="workspace-host">
        <div className="items-body">
          <FeedbackPanel host={props.host} sessionId={props.sessionId} feedback={feedback} canSend={props.canSend} onSend={props.onSend} onError={props.onError} focus={props.focus} onOpenItem={props.onOpenItem} onWorkspace={(item) => void workspace.openItem(item)} workspaceOpening={workspace.opening} inlineGraph />
        </div>
        {open && (
          <WorkspaceLayer key={open.board} host={props.host} sessionId={props.sessionId} path={props.path} board={open.board} n={open.n} item={feedback.doc?.items.find((i) => i.n === open.n)} onBack={workspace.close} onError={props.onError} />
        )}
      </div>
    </div>
  );
}
