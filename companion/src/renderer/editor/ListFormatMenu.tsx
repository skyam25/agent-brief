/** The right-click menu on a numbered list, as in Notion. It sets the format of that one list. */

import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useEscape, usePointerOutside } from '../hooks';
import { CheckIcon } from '../Icons';
import { LIST_FORMATS, type ListFormat } from './lists';

const MARGIN = 8;

export function ListFormatMenu(props: { x: number; y: number; current: ListFormat; onPick: (format: ListFormat) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState({ left: props.x, top: props.y });
  useEscape(props.onClose);
  usePointerOutside(ref, props.onClose);

  // Keeps the menu on screen near the window's right and bottom edges.
  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    setAt({
      left: Math.max(MARGIN, Math.min(props.x, window.innerWidth - box.width - MARGIN)),
      top: Math.max(MARGIN, Math.min(props.y, window.innerHeight - box.height - MARGIN)),
    });
  }, [props.x, props.y]);

  return createPortal(
    <div className="list-format-menu" ref={ref} style={at} role="menu" aria-label="List format" data-escape-owner data-testid="list-format-menu">
      <h4>List format</h4>
      {LIST_FORMATS.map(({ format, label, sample }) => (
        <button
          key={format}
          type="button"
          className="ghost"
          role="menuitemradio"
          aria-checked={props.current === format}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => props.onPick(format)}
          data-testid="list-format"
          data-format={format}
        >
          <span className="list-format-sample" aria-hidden="true">
            {sample}
          </span>
          <span className="label-text">{label}</span>
          {props.current === format && <CheckIcon />}
        </button>
      ))}
    </div>,
    document.body,
  );
}
