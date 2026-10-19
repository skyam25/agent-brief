/**
 * Feedback items for one output: grouped by the round they first came up in,
 * newest round on top. Each decision, note and voice note saves to the file at
 * once as a dated You line. Send decisions hands Claude what you said and saved since the last send.
 * On a page, a click lists the items on that element, and a picked item ties the next pin to it.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { FeedbackDocument, FeedbackFileSummary, FeedbackItem, FeedbackOp } from '../protocol';
import { decisionsPrompt, pendingDecisions, receiptBatches, type PendingDecision } from '../shared/feedback';
import { workspaceSummary } from '../shared/feedback-workspace';
import type { CompanionApi } from '../shared/ipc';
import { BeforeAfter, type PictureHost } from './BeforeAfter';
import { FeedbackGraph } from './FeedbackGraph';
import { ExternalIcon, MicIcon } from './Icons';
import { ReviewVoice } from './review-voice';
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

export const openCount = (doc?: FeedbackDocument) => doc?.items.filter((i) => i.state === 'open').length ?? 0;

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
  /** The item to scroll to and mark when the panel opens. */
  focus?: number;
  /** Opens an item of another output, from the graph. */
  onOpenItem?: (output: string, n: number) => void;
  /** The items on the page element clicked last. Absent until a click. */
  pointed?: number[];
  /** The item the next review pin joins. */
  picked?: number;
  onPick?: (n: number | undefined) => void;
}) {
  const { doc, error, apply } = props.feedback;
  const [graphShown, setGraphShown] = useState(false);
  /** Bumps on Refresh, so the graph reads the files again too. */
  const [graphReads, setGraphReads] = useState(0);
  const [focus, setFocus] = useState(props.focus);
  const root = useRef<HTMLElement>(null);
  useEffect(() => {
    if (graphShown || focus === undefined || !doc) return;
    root.current?.querySelector(`[data-testid="feedback-item-${focus}"]`)?.scrollIntoView({ block: 'center' });
  }, [graphShown, focus, doc?.path]);
  const openItem = (output: string, n: number) => {
    if (doc && output !== doc.output) return props.onOpenItem?.(output, n);
    setGraphShown(false);
    setFocus(n);
  };
  /** Marks an item, so the next pin on the page joins it. */
  const pick = (n: number) => {
    openItem(doc?.output ?? '', n);
    props.onPick?.(n);
  };
  const sources = new Map((doc?.rounds ?? []).flatMap((r) => (r.source ? [[r.n, r.source] as const] : [])));
  const openSource = (path: string) => {
    if (props.sessionId) void props.host.openItemOutput(props.sessionId, path).catch((err: Error) => props.onError(`Could not open ${path}: ${cleanError(err)}`));
  };
  const applyRef = useRef(apply);
  applyRef.current = apply;
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
  /** Writes a receipt on each item through the last event sent. Throws naming the items left unmarked. */
  const markSent = async (sent: PendingDecision[]) => {
    const unmarked: string[] = [];
    for (const ops of receiptBatches(sent)) {
      if (!(await applyRef.current(ops))) unmarked.push(...ops.map((o) => (o.op === 'append' ? `#${o.item}` : '')));
    }
    if (unmarked.length) throw new Error(`the file was not marked for ${unmarked.join(', ')}. The next Send repeats them.`);
  };
  const send = () => {
    if (!props.sessionId || !pending.length) return;
    props.onSend(props.sessionId, async () => {
      // Words still turning into text reach the file before the send reads it.
      await voice.stop();
      await Promise.all([...writes.current]);
      const fresh = await props.feedback.reload();
      if (!fresh) return 'Could not read the feedback file. Nothing was sent.';
      const now = pendingDecisions(fresh);
      if (!now.length) return 'Decide something first.';
      return { text: decisionsPrompt(fresh, now), onSent: () => markSent(now) };
    });
  };

  const items = doc?.items ?? [];
  const rounds = [...(doc?.rounds ?? [])].sort((a, b) => b.n - a.n);
  const known = new Set(rounds.map((r) => r.n));
  const loose = items.filter((i) => i.round === undefined || !known.has(i.round));
  const showItem = (item: FeedbackItem) =>
    props.onShow &&
    ((selector: string) => {
      props.onShow!(selector);
      props.onPick?.(item.n);
    });
  const sourceOf = (item: FeedbackItem) => {
    const src = item.sources[0];
    return src && sources.get(src.round);
  };
  const pictures = (item: FeedbackItem) => doc && <BeforeAfter host={props.host} sessionId={props.sessionId} output={doc.output} item={item} />;

  return (
    <section className="feedback-panel" aria-label="Feedback" data-testid="feedback-panel" ref={root}>
      <div className="behavior-heading">
        <h3>Feedback{items.length > 0 ? ` · ${openCount(doc)} open` : ''}</h3>
        <span className="feedback-heading-actions">
          <button className="ghost" aria-pressed={graphShown} title="How this project's sources, items, outputs and workspaces link" onClick={() => setGraphShown(!graphShown)} data-testid="feedback-graph-toggle">
            Graph
          </button>
          <button
            className="ghost"
            onClick={() => {
              props.feedback.refresh();
              setGraphReads((n) => n + 1);
            }}
            data-testid="feedback-refresh"
          >
            Refresh
          </button>
        </span>
      </div>
      {doc && <p className="muted feedback-path" title={doc.path}>{doc.path}</p>}
      {error && <p role="alert" className="behavior-error">{error}</p>}
      {!doc && !error && <p>Loading feedback…</p>}
      {graphShown && <FeedbackGraph host={props.host} sessionId={props.sessionId} output={doc?.output} reads={graphReads} onOpenItem={openItem} />}
      {!graphShown && props.onPick && items.length > 0 && (props.pointed || props.picked !== undefined) && (
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
      {!graphShown && doc && !items.length && (
        <p className="muted" data-testid="feedback-empty">
          No feedback yet. Hand Claude a transcript and ask it to catalog the points against this output.
        </p>
      )}
      {!graphShown && rounds.map((r) => {
        const group = items.filter((i) => i.round === r.n);
        if (!group.length) return null;
        return (
          <div key={r.n} className="feedback-round" data-testid={`feedback-round-${r.n}`}>
            <h4 className="section-head" title={r.source}>
              Round {r.n} · {r.label}
              <span className="muted"> · {r.date}</span>
            </h4>
            <ol className="review-cards">
              {group.map((item) => (
                <ItemCard key={item.n} item={item} voice={voice} onApply={apply} onShow={showItem(item)} onVoice={() => void toggleVoice(item.n)} pictures={pictures(item)} focused={item.n === focus} onWorkspace={props.onWorkspace} opening={props.workspaceOpening === item.n} source={sourceOf(item)} onSource={openSource} />
              ))}
            </ol>
          </div>
        );
      })}
      {!graphShown && loose.length > 0 && (
        <ol className="review-cards">
          {loose.map((item) => (
            <ItemCard key={item.n} item={item} voice={voice} onApply={apply} onShow={showItem(item)} onVoice={() => void toggleVoice(item.n)} pictures={pictures(item)} focused={item.n === focus} onWorkspace={props.onWorkspace} opening={props.workspaceOpening === item.n} source={sourceOf(item)} onSource={openSource} />
          ))}
        </ol>
      )}
      {!graphShown && items.length > 0 && (
        <footer className="feedback-foot">
          <button
            className="chip"
            disabled={!pending.length || !props.canSend}
            title={!props.canSend ? 'This session has ended. Resume it to send.' : pending.length ? 'Hand Claude what you decided since the last send' : 'Decide something first'}
            onClick={send}
            data-testid="feedback-send"
          >
            Send decisions{pending.length ? ` · ${pending.length}` : ''}
          </button>
          <span className="muted">Decisions save as you make them.</span>
        </footer>
      )}
    </section>
  );
}

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

function ItemCard(props: {
  item: FeedbackItem;
  voice: ReviewVoice;
  onApply: (ops: FeedbackOp[]) => Promise<boolean>;
  onShow?: (selector: string) => void;
  onVoice: () => void;
  onWorkspace?: (item: FeedbackItem) => void;
  opening?: boolean;
  /** The item's before and after pictures. */
  pictures?: ReactNode;
  /** The graph opened this item. */
  focused?: boolean;
  /** The transcript of the first quote's round, when it names one. */
  source?: string;
  onSource?: (path: string) => void;
}) {
  const { item } = props;
  const workspace = workspaceSummary(item);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const listening = props.voice.recording && props.voice.target === String(item.n);
  const [first, ...later] = item.rounds;
  const src = item.sources[0];
  const say = async (verb: 'accept' | 'reject' | 'reopen' | 'note') => {
    const detail = oneLine(note);
    if (verb === 'note' && !detail) return;
    setSaving(true);
    const ok = await props.onApply([{ op: 'append', item: item.n, key: 'You', text: detail ? `${verb} · ${detail}` : verb }]);
    setSaving(false);
    if (ok) setNote('');
  };
  const history = item.lines.filter((l) => l.key !== 'Round');

  return (
    <li className={`review-card feedback-item ${item.state}${listening ? ' listening' : ''}${props.focused ? ' focused' : ''}`} data-testid={`feedback-item-${item.n}`}>
      <div className="review-card-head">
        <span className="num">#{item.n}</span>
        <span className="feedback-title">{item.title}</span>
      </div>
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
      </div>
      {src && (
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
      {item.change && <p className="feedback-change">{item.change}</p>}
      {item.where && (
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
      {props.pictures}
      {(props.onWorkspace || workspace) && (
        <div className="feedback-workspace">
          {props.onWorkspace && (
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
      <div className="behavior-actions">
        <button className={item.state === 'accepted' ? 'chip on' : 'chip'} aria-pressed={item.state === 'accepted'} disabled={saving} onClick={() => item.state !== 'accepted' && void say('accept')} data-testid="feedback-accept">
          Accept
        </button>
        <button className={item.state === 'rejected' ? 'chip on' : 'chip'} aria-pressed={item.state === 'rejected'} disabled={saving} onClick={() => item.state !== 'rejected' && void say('reject')} data-testid="feedback-reject">
          Reject
        </button>
        {item.state !== 'open' && (
          <button className="ghost" disabled={saving} onClick={() => void say('reopen')} data-testid="feedback-reopen">
            Reopen
          </button>
        )}
      </div>
      <div className="feedback-note">
        <input
          aria-label={`Note on #${item.n}`}
          placeholder={listening ? 'Listening…' : 'Add a note, or a reason with Accept or Reject'}
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
      {history.length > 0 && (
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
  host: FeedbackHost & WorkspaceHost;
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
        <button className="ghost" onClick={props.onOpenFile} data-testid="feedback-open-file">
          <ExternalIcon /> Open file
        </button>
      </header>
      <div className="workspace-host">
        <div className="items-body">
          <FeedbackPanel host={props.host} sessionId={props.sessionId} feedback={feedback} canSend={props.canSend} onSend={props.onSend} onError={props.onError} focus={props.focus} onOpenItem={props.onOpenItem} onWorkspace={(item) => void workspace.openItem(item)} workspaceOpening={workspace.opening} />
        </div>
        {open && (
          <WorkspaceLayer key={open.board} host={props.host} sessionId={props.sessionId} path={props.path} board={open.board} n={open.n} item={feedback.doc?.items.find((i) => i.n === open.n)} onBack={workspace.close} onError={props.onError} />
        )}
      </div>
    </div>
  );
}
