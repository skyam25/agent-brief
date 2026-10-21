/**
 * A feedback item's workspace: a full layer over the output with the item's own
 * Sketch board, the board's comment pins and mic, and one column with the unsaved
 * comments first and what was said about the item after. Save to #N exports the board beside the output and logs it, and the comments,
 * on the item. Add to note opens a Write note linked to the item. Nothing goes to Claude.
 */

import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { FeedbackItem } from '../protocol';
import { hasBoardComments } from '../shared/board-comments';
import { quoted } from '../shared/feedback';
import { railEntries, shortDate, workspaceQuote, workspaceRound, workspaceSummary, type WorkspaceSnapshot } from '../shared/feedback-workspace';
import type { BoardHost, CompanionApi, Theme } from '../shared/ipc';
import { BoardCanvas } from './BoardCanvas';
import { CommentColumn, CommentToggle, useCommentKeys } from './BoardComments';
import { BoardController, parseScene, type LoadedScene } from './controller';
import { Mic } from './Mic';
import { OVERALL, ReviewVoice, hostDictation } from './review-voice';
import { claimTalk } from './talk-owner';
import { fitBoard } from './viewport';
import { holdWorkspace, workspaceComments as comments } from './workspace-boards';

export type WorkspaceHost = BoardHost &
  Pick<CompanionApi, 'openFeedbackWorkspace' | 'saveFeedbackWorkspace' | 'noteFeedbackItem' | 'transcribeClip' | 'startDictation' | 'stopDictation' | 'onDictation' | 'requestMicrophone' | 'onVisibility'>;

const MIC_DENIED = 'Microphone access is off. Turn it on in System Settings > Privacy & Security > Microphone, then try again.';

const cleanError = (err: unknown) => (err as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

const RAIL_LABELS = { note: 'Note', voice: 'Voice', pin: 'Pin' } as const;

/** Which item's workspace is open, and the call that opens one. */
export function useItemWorkspace(props: {
  host: WorkspaceHost;
  sessionId?: string;
  path: string;
  /** A picture of the item's element on the live page. Absent where no page shows. */
  capture?: (selector: string) => Promise<WorkspaceSnapshot | undefined>;
  onError: (message: string) => void;
}) {
  const { host, sessionId, path, capture, onError } = props;
  const [open, setOpen] = useState<{ n: number; board: string }>();
  const [opening, setOpening] = useState<number>();
  const openItem = useCallback(
    async (item: FeedbackItem) => {
      if (!sessionId) return;
      setOpening(item.n);
      try {
        // Main draws the picture only into a new round's frame.
        const snapshot = item.where && capture ? await capture(item.where).catch(() => undefined) : undefined;
        const ws = await host.openFeedbackWorkspace(sessionId, path, item.n, snapshot);
        setOpen({ n: item.n, board: ws.board });
      } catch (err) {
        onError(`Could not open the workspace: ${cleanError(err)}`);
      } finally {
        setOpening(undefined);
      }
    },
    [host, sessionId, path, capture, onError],
  );
  const close = useCallback(() => setOpen(undefined), []);
  return { open, opening, openItem, close };
}

/** Shows the newest round's frame, the right-most one, or the whole board when it has no frame. */
function showNewestRound(api: ExcalidrawImperativeAPI): void {
  const live = api.getSceneElements();
  const newest = live.filter((e) => e.type === 'frame').sort((a, b) => b.x - a.x)[0];
  fitBoard(api, newest ? live.filter((e) => e.id === newest.id || e.frameId === newest.id) : live);
}

const currentTheme = (): Theme => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');

export function WorkspaceLayer(props: {
  host: WorkspaceHost;
  sessionId: string;
  path: string;
  board: string;
  /** The item as the feedback file has it now. */
  item?: FeedbackItem;
  n: number;
  onBack: () => void;
  onError: (message: string) => void;
}) {
  const { host, board } = props;
  const [loaded, setLoaded] = useState<{ controller: BoardController; scene: LoadedScene }>();
  const [theme, setTheme] = useState(currentTheme);
  const [saving, setSaving] = useState(false);
  const [voice] = useState(
    () =>
      new ReviewVoice({
        transcribe: (clip) => host.transcribeClip(clip),
        dictate: hostDictation(host),
        onText: (target, text) => comments.append(board, target, text),
        onError: props.onError,
      }),
  );
  const recording = useSyncExternalStore(
    (fn) => voice.subscribe(fn),
    () => voice.recording,
  );
  const selected = useSyncExternalStore(
    (fn) => comments.subscribe(fn),
    () => comments.selected,
  );
  useCommentKeys(comments, true);

  // Words go to the selected pin, so the mic follows the selection.
  useEffect(() => {
    if (voice.recording) voice.aim(selected ?? OVERALL);
  }, [voice, selected]);

  // Leaving or hiding the panel stops the mic. Words still turning into text land on their pins, which stay for the next open.
  useEffect(() => {
    const off = host.onVisibility((visible) => !visible && void voice.stop());
    return () => {
      if (typeof off === 'function') off();
      void voice.stop();
      comments.setTool(false);
    };
  }, [host, voice]);

  const toggleMic = async () => {
    if (voice.recording) return void (await voice.stop());
    const access = await host.requestMicrophone();
    if (!access.granted) return props.onError(MIC_DENIED);
    comments.setTool(true);
    await voice.start(comments.selected ?? OVERALL).catch((err: Error) => props.onError(`Could not start the microphone: ${err.message}`));
  };

  // ⌥T talks to this layer's mic while it shows.
  const talk = useRef(toggleMic);
  talk.current = toggleMic;
  useEffect(() => claimTalk(() => void talk.current()), []);

  useEffect(() => {
    const off = host.onTheme(setTheme);
    return () => {
      if (typeof off === 'function') off();
    };
  }, [host]);

  useEffect(() => {
    let gone = false;
    let controller: BoardController | undefined;
    let release: (() => void) | undefined;
    host
      .loadBoard(board)
      .then(({ scene, notes }) => {
        if (gone) return;
        const parsed = parseScene(scene);
        controller = new BoardController(host, { board, notes, scene: parsed });
        release = holdWorkspace(controller);
        setLoaded({ controller, scene: parsed });
      })
      .catch((err) => props.onError(`Could not load the workspace: ${cleanError(err)}`));
    // The board keeps everything; leaving writes the last changes.
    return () => {
      gone = true;
      release?.();
      void controller?.flush().catch(() => undefined);
    };
  }, [host, board]);

  const save = async () => {
    if (!loaded) return;
    setSaving(true);
    try {
      await voice.stop();
      await loaded.controller.flush();
      const kept = comments.of(board);
      await host.saveFeedbackWorkspace(props.sessionId, props.path, props.n, hasBoardComments(kept) ? kept : undefined);
      // The item has the saved words now. Words added while saving stay for the next Save.
      for (const p of kept.pins) if (comments.of(board).pins.find((q) => q.id === p.id)?.text === p.text) comments.remove(board, p.id);
      if (comments.of(board).overall === kept.overall) comments.setOverall(board, '');
    } catch (err) {
      props.onError(`Could not save the workspace: ${cleanError(err)}`);
    } finally {
      setSaving(false);
    }
  };

  const back = async () => {
    await loaded?.controller.flush().catch(() => undefined);
    props.onBack();
  };

  const addToNote = async () => {
    await loaded?.controller.flush().catch(() => undefined);
    try {
      await host.noteFeedbackItem(props.sessionId, props.path, props.n);
    } catch (err) {
      props.onError(`Could not open the note: ${cleanError(err)}`);
    }
  };

  const item = props.item;
  const src = item && workspaceQuote(item, workspaceRound(item));
  const rail = item ? railEntries(item) : [];
  const summary = item && workspaceSummary(item);

  return (
    <section className="workspace-layer" aria-label={`Workspace for #${props.n}`} data-escape-owner data-testid="workspace-layer">
      <header className="workspace-head">
        <div className="workspace-what">
          <span className="workspace-title" title={item?.title}>
            <span className="num">#{props.n}</span> {item?.title}
          </span>
          {src?.quote && (
            <span className="muted workspace-quote" title={src.quote}>
              {quoted(src.quote)}{src.speaker ? ` — ${src.speaker}` : ''}
            </span>
          )}
        </div>
        <div className="workspace-actions">
          <CommentToggle comments={comments} />
          <Mic recording={recording} board onMicrophone={() => void toggleMic()} />
          <button className="ghost" onClick={() => void addToNote()} title="Open a Write note linked to this item" data-testid="workspace-note">
            Add to note
          </button>
          <button className="ghost" onClick={() => void back()} title="Back to the feedback list" data-testid="workspace-back">
            Back<span className="wide-label">to list</span>
          </button>
          <button className="primary" disabled={!loaded || saving} onClick={() => void save()} title="Export the board beside the output and log it and the comments on the item. Nothing is sent." data-testid="workspace-save">
            {saving ? 'Saving…' : `Save to #${props.n}`}
          </button>
        </div>
      </header>
      <div className="workspace-body">
        {loaded ? (
          <BoardCanvas controller={loaded.controller} scene={loaded.scene} theme={theme} active onReady={(api) => requestAnimationFrame(() => showNewestRound(api))} comments={comments} board={board} />
        ) : (
          <p className="muted workspace-loading">Opening the workspace…</p>
        )}
        {/* One column: what this Save will keep, then what the item already has. */}
        <CommentColumn
          comments={comments}
          board={board}
          voice={voice}
          foot="Save keeps each pin's words on the item, numbered on the saved picture. ⌘↩ saves."
          onSendKeys={(e) => {
            if (e.key === 'Enter' && e.metaKey) {
              e.preventDefault();
              void save();
            }
          }}
        >
          <section className="workspace-rail" aria-label="Notes, voice and pins" data-testid="workspace-rail">
            <h3 className="section-head">Said about #{props.n}</h3>
            <p className="muted workspace-board" title="Claude draws here with agent-brief draw --board" data-testid="workspace-board">
              {board}
            </p>
            {summary && (
              <p className="muted" data-testid="workspace-saved">
                {summary}
              </p>
            )}
            {rail.length === 0 && <p className="muted">No notes, voice notes or pins yet.</p>}
            {rail.map((r, i) => (
              <p key={i} className={`workspace-rail-entry ${r.kind}`} data-testid="workspace-rail-entry">
                <span className="who">
                  {RAIL_LABELS[r.kind]}
                  {r.date ? ` · ${shortDate(r.date)}` : ''}
                </span>
                {r.text}
              </p>
            ))}
          </section>
        </CommentColumn>
      </div>
    </section>
  );
}
