/**
 * A feedback item's workspace: a full layer over the output with the item's own
 * Sketch board and a rail of what was said about it. Save to #N exports the
 * board beside the output and logs it on the item. Nothing goes to Claude.
 */

import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { useCallback, useEffect, useState } from 'react';
import type { FeedbackItem } from '../protocol';
import { railEntries, shortDate, workspaceQuote, workspaceRound, workspaceSummary, type WorkspaceSnapshot } from '../shared/feedback-workspace';
import type { BoardHost, CompanionApi, Theme } from '../shared/ipc';
import { BoardCanvas } from './BoardCanvas';
import { BoardCommentsStore } from './board-comments';
import { BoardController, parseScene, type LoadedScene } from './controller';
import { fitBoard } from './viewport';
import { holdWorkspace } from './workspace-boards';

export type WorkspaceHost = BoardHost & Pick<CompanionApi, 'openFeedbackWorkspace' | 'saveFeedbackWorkspace'>;

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
  const [comments] = useState(() => new BoardCommentsStore());
  const [theme, setTheme] = useState(currentTheme);
  const [saving, setSaving] = useState(false);

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
      await loaded.controller.flush();
      await host.saveFeedbackWorkspace(props.sessionId, props.path, props.n);
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

  const item = props.item;
  const src = item && workspaceQuote(item, workspaceRound(item));
  const rail = item ? railEntries(item) : [];
  const summary = item && workspaceSummary(item);

  return (
    <section className="workspace-layer" aria-label={`Workspace for #${props.n}`} data-escape-owner data-testid="workspace-layer">
      <header className="workspace-head">
        <div className="workspace-what">
          <span className="workspace-title">
            <span className="num">#{props.n}</span> {item?.title}
          </span>
          {src?.quote && (
            <span className="muted workspace-quote" title={src.quote}>
              “{src.quote}”{src.speaker ? ` — ${src.speaker}` : ''}
            </span>
          )}
        </div>
        <span className="muted workspace-board" title="Claude draws here with agent-brief draw --board" data-testid="workspace-board">
          {board}
        </span>
        {summary && (
          <span className="muted" data-testid="workspace-saved">
            {summary}
          </span>
        )}
        <button className="ghost" onClick={() => void back()} data-testid="workspace-back">
          Back to list
        </button>
        <button className="primary" disabled={!loaded || saving} onClick={() => void save()} title="Export the board beside the output and log it on the item. Nothing is sent." data-testid="workspace-save">
          {saving ? 'Saving…' : `Save to #${props.n}`}
        </button>
      </header>
      <div className="workspace-body">
        {loaded ? (
          <BoardCanvas controller={loaded.controller} scene={loaded.scene} theme={theme} active onReady={(api) => requestAnimationFrame(() => showNewestRound(api))} comments={comments} board={board} />
        ) : (
          <p className="muted workspace-loading">Opening the workspace…</p>
        )}
        <aside className="workspace-rail" aria-label="Notes, voice and pins" data-testid="workspace-rail">
          <h4 className="section-head">Said about #{props.n}</h4>
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
        </aside>
      </div>
    </section>
  );
}
