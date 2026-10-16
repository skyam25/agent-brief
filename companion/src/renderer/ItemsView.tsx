/** Review mode's items pane: the active session's items file, with a decision field on each open item. */

import { useEffect } from 'react';
import type { SessionBriefEntry } from '../shared/ipc';
import { awaitsUser, type Item } from '../shared/items';
import { shortFolder, shortPath } from '../shared/sessions';
import { useStore } from './hooks';
import { CheckIcon } from './Icons';
import type { ItemsStore } from './items';

interface Props {
  store: ItemsStore;
  /** The active session tab's brief. Undefined on the Notes tab. */
  brief?: SessionBriefEntry;
  home: string;
  onTrack: (sessionId: string, on: boolean) => void;
  onSend: () => void;
  /** Opens a file from an item's `Out:` lines. */
  onOpenOutput: (sessionId: string, path: string) => void;
}

export function ItemsView(props: Props) {
  const { store, brief } = props;
  const sessionId = brief?.sessionId;
  useStore(store);
  const tracking = !!brief?.trackItems;

  // Turning tracking on may find a file Claude already wrote. A failed read keeps the last copy.
  useEffect(() => {
    if (sessionId) void store.load(sessionId).catch(() => undefined);
  }, [store, sessionId, tracking]);

  if (!sessionId || !brief) {
    return (
      <div className="items" data-testid="items">
        <p className="muted items-empty" data-testid="items-no-session">
          Open the panel from a Claude Code session (/sketch or /write) to track its items.
        </p>
      </div>
    );
  }

  const info = store.doc(sessionId);
  const items = info?.doc.items ?? [];
  const open = items.filter((i) => !i.done).length;

  return (
    <div className="items" data-testid="items">
      <header className="items-head">
        <div className="items-title">
          <span className="title">{brief.title}</span>
          {tracking && info && (
            <span className="muted path" title={info.path} data-testid="items-path">
              {shortPath(info.path, props.home)}
            </span>
          )}
        </div>
        <button
          className="ghost switch"
          role="switch"
          aria-checked={tracking}
          onClick={() => props.onTrack(sessionId, !tracking)}
          data-testid="track-toggle"
        >
          <span className="track" aria-hidden="true" />
          Track items
        </button>
      </header>
      <div className="items-body">
        {!tracking && (
          <p className="muted items-empty">
            Turn on Track items and Claude keeps a list of this work's items here, with its questions. You answer on each one.
          </p>
        )}
        {tracking && !info?.exists && <p className="muted items-empty">No items yet. Claude writes them here when the work has several parts.</p>}
        {tracking && items.length > 0 && (
          <ol className="item-list" data-testid="item-list">
            {items.map((item) => (
              <ItemRow
                key={item.n}
                item={item}
                decision={store.decision(sessionId, item.n)}
                onDecide={(text) => store.setDecision(sessionId, item.n, text)}
                onSend={props.onSend}
                onOpenOutput={(path) => props.onOpenOutput(sessionId, path)}
              />
            ))}
          </ol>
        )}
      </div>
      {tracking && items.length > 0 && (
        <footer className="items-foot muted" data-testid="items-count">
          {open} open · {items.length - open} done
        </footer>
      )}
    </div>
  );
}

interface RowProps {
  item: Item;
  decision: string;
  onDecide: (text: string) => void;
  onSend: () => void;
  onOpenOutput: (path: string) => void;
}

function ItemRow(props: RowProps) {
  const { item } = props;
  const waiting = awaitsUser(item);
  return (
    <li className={item.done ? 'item done' : waiting ? 'item waiting' : 'item'} data-testid={`item-${item.n}`}>
      <div className="item-head">
        <span className="num">#{item.n}</span>
        <span className="item-title">{item.title}</span>
        {item.done && (
          <span className="done-mark" title="Done" aria-label="Done">
            <CheckIcon />
          </span>
        )}
        {waiting && (
          <span className="waiting-tag" data-testid="item-waiting">
            Waiting on you
          </span>
        )}
      </div>
      {item.notes.map((note, i) => (
        <p key={`n${i}`} className="item-note">
          {note}
        </p>
      ))}
      {item.lines.map((line, i) => (
        <p key={`l${i}`} className={`item-line ${line.by}`}>
          <span className="who">{line.by === 'you' ? 'You' : 'Claude'}</span>
          {line.text}
        </p>
      ))}
      {item.outputs.length > 0 && (
        <div className="item-outputs" data-testid={`outputs-${item.n}`}>
          <span className="who">{item.done ? 'Files' : 'Working on'}</span>
          {item.outputs.map((path, i) => (
            <button
              key={path}
              className="link output"
              title={path}
              onClick={() => props.onOpenOutput(path)}
              data-testid={`output-${item.n}-${i}`}
            >
              {shortFolder(path)}
            </button>
          ))}
        </div>
      )}
      {!item.done && (
        <input
          className="decision"
          aria-label={`Your call on #${item.n}`}
          placeholder="Your call"
          value={props.decision}
          onChange={(e) => props.onDecide(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && e.metaKey) {
              e.preventDefault();
              props.onSend();
            }
          }}
          data-testid={`decision-${item.n}`}
        />
      )}
    </li>
  );
}
