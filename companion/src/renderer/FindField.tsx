/** The find bar's look and keys, shared by notes and review pages. Enter goes to the next match, ⇧Enter the previous one, and Escape closes. */

import type { RefObject } from 'react';
import { ChevronIcon, CloseIcon } from './Icons';

export interface FindCount {
  total: number;
  /** Index of the match in focus. -1 when there is none. */
  current: number;
}

export function FindField(props: {
  label: string;
  value: string;
  count: FindCount;
  inputRef: RefObject<HTMLInputElement | null>;
  onChange: (value: string) => void;
  onStep: (dir: 1 | -1) => void;
  onClose: () => void;
}) {
  const { count } = props;
  const status = !props.value ? '' : count.total ? `${count.current + 1} of ${count.total}` : 'No matches';
  return (
    <div className="find-host">
      <div className="find-bar" role="search" aria-label={props.label} data-escape-owner data-testid="find-bar">
        <input
          ref={props.inputRef}
          type="text"
          placeholder={props.label}
          aria-label={props.label}
          value={props.value}
          spellCheck={false}
          onChange={(e) => props.onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              props.onStep(e.shiftKey ? -1 : 1);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              props.onClose();
            }
          }}
          data-testid="find-input"
        />
        <span className="find-count muted" aria-live="polite" data-testid="find-count">
          {status}
        </span>
        <button className="ghost icon-button small flip" title="Previous match (⇧⌘G)" aria-label="Previous match" disabled={!count.total} onClick={() => props.onStep(-1)}>
          <ChevronIcon />
        </button>
        <button className="ghost icon-button small" title="Next match (⌘G)" aria-label="Next match" disabled={!count.total} onClick={() => props.onStep(1)}>
          <ChevronIcon />
        </button>
        <button className="ghost icon-button small" title="Close (Esc)" aria-label="Close find" onClick={props.onClose} data-testid="find-close">
          <CloseIcon />
        </button>
      </div>
    </div>
  );
}
