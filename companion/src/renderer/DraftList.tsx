import { useState, type DragEvent, type KeyboardEvent, type MouseEvent } from 'react';
import { draftPreview, draftTitle } from '../shared/drafts';
import type { Draft } from '../shared/ipc';
import { baseName, commentCount } from '../shared/review';
import { plainSlots } from '../shared/slots';
import { GripIcon, LinkIcon } from './Icons';

/** `5m`, `3h`, or a date, for the list. */
export function ago(ms: number, now = Date.now()): string {
  const s = Math.max(0, (now - ms) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/** Ready drafts in send order. Drag the grip, or press ⌥↑ and ⌥↓, to reorder. */
export function ReadyQueue(props: {
  drafts: Draft[];
  selectedId?: string;
  reorder: boolean;
  onOpen: (id: string) => void;
  /** Moves a draft to `index` among these drafts, counted without it. */
  onMove: (id: string, index: number) => void;
  /** A right-click on a row. */
  onMenu?: (id: string, e: MouseEvent) => void;
}) {
  const [dragging, setDragging] = useState<string>();
  const [dropAt, setDropAt] = useState<number>();

  /** Where a drop over row `i` lands, counted without the dragged draft. */
  const indexAt = (e: DragEvent, i: number) => {
    const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const after = e.clientY > box.top + box.height / 2;
    const from = props.drafts.findIndex((d) => d.id === dragging);
    const at = i + (after ? 1 : 0);
    return from !== -1 && from < at ? at - 1 : at;
  };

  const nudge = (e: KeyboardEvent, d: Draft, i: number) => {
    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    props.onMove(d.id, e.key === 'ArrowUp' ? i - 1 : i + 1);
  };

  if (props.drafts.length === 0) return null;
  return (
    <section>
      <SectionHeader title="Ready" count={props.drafts.length} />
      <ul data-testid="ready-list" onDragLeave={() => setDropAt(undefined)}>
        {props.drafts.map((d, i) => (
          <DraftRow
            key={d.id}
            draft={d}
            selected={d.id === props.selectedId}
            onSelect={() => props.onOpen(d.id)}
            onMenu={props.onMenu && ((e) => props.onMenu!(d.id, e))}
            onKeyDown={props.reorder ? (e) => nudge(e, d, i) : undefined}
            drag={
              props.reorder
                ? {
                    dragging: dragging === d.id,
                    dropBefore: dropAt === i && dragging !== d.id,
                    onDragStart: (e) => {
                      e.dataTransfer.setData('text/plain', d.id);
                      e.dataTransfer.effectAllowed = 'move';
                      setDragging(d.id);
                    },
                    onDragEnd: () => {
                      setDragging(undefined);
                      setDropAt(undefined);
                    },
                    onDragOver: (e) => {
                      e.preventDefault();
                      const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
                      setDropAt(e.clientY > box.top + box.height / 2 ? i + 1 : i);
                    },
                    onDrop: (e) => {
                      e.preventDefault();
                      if (dragging) props.onMove(dragging, indexAt(e, i));
                      setDragging(undefined);
                      setDropAt(undefined);
                    },
                  }
                : undefined
            }
          />
        ))}
      </ul>
    </section>
  );
}

export function DraftRow(props: {
  draft: Draft;
  selected: boolean;
  onSelect: () => void;
  onMenu?: (e: MouseEvent) => void;
  onKeyDown?: (e: KeyboardEvent) => void;
  drag?: {
    dragging: boolean;
    dropBefore: boolean;
    onDragStart: (e: DragEvent) => void;
    onDragEnd: () => void;
    onDragOver: (e: DragEvent) => void;
    onDrop: (e: DragEvent) => void;
  };
}) {
  const { draft: d, drag } = props;
  const body = plainSlots(d.body);
  const title = d.review ? `Review of ${baseName(d.review.path)}` : d.title || draftTitle(body) || 'Empty note';
  const preview = d.review ? commentCount(d.review.comments.length) : d.title ? draftTitle(body) : draftPreview(body);
  return (
    <li
      className={drag?.dropBefore ? 'drop-before' : undefined}
      draggable={!!drag}
      onDragStart={drag?.onDragStart}
      onDragEnd={drag?.onDragEnd}
      onDragOver={drag?.onDragOver}
      onDrop={drag?.onDrop}
      data-dragging={drag?.dragging || undefined}
    >
      <button
        className="ghost draft-row"
        aria-current={props.selected}
        onClick={props.onSelect}
        onContextMenu={props.onMenu}
        onKeyDown={props.onKeyDown}
        title={drag ? 'Drag, or press ⌥↑ and ⌥↓, to reorder' : undefined}
        data-testid="draft-row"
      >
        {drag && (
          <span className="grip" aria-hidden="true">
            <GripIcon />
          </span>
        )}
        <span className="lines">
          <span className="title-line">
            <span className={d.body.trim() || d.review ? 'title' : 'title muted'}>{title}</span>
            <span className="muted when">{ago(d.updatedAt)}</span>
          </span>
          <span className="muted preview">
            {d.board && (
              <span className="board-tag" title={`Goes with the board ${d.board}`}>
                <LinkIcon /> {d.board}
              </span>
            )}
            {preview}
          </span>
        </span>
      </button>
    </li>
  );
}

/** A list section's name and count. With `onToggle`, a click folds the section. */
export function SectionHeader(props: { title: string; count: number; open?: boolean; onToggle?: () => void; testId?: string }) {
  const label = (
    <>
      {props.onToggle && (
        <span className="caret" aria-hidden="true">
          {props.open ? '▾' : '▸'}
        </span>
      )}
      {props.title}
      {props.count > 0 && <span className="count">{props.count}</span>}
    </>
  );
  return (
    <h3 className="section-head">
      {props.onToggle ? (
        <button className="ghost section-toggle" aria-expanded={props.open} onClick={props.onToggle} data-testid={props.testId}>
          {label}
        </button>
      ) : (
        label
      )}
    </h3>
  );
}
