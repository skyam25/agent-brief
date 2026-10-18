/** A menu at the pointer, for a right-click. It stays on screen near the window's edges. */

import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useEscape, usePointerOutside } from './hooks';

const MARGIN = 8;

export interface MenuPoint {
  x: number;
  y: number;
}

export function ContextMenu(
  props: MenuPoint & {
    label: string;
    testId: string;
    onClose: () => void;
    /** Opens above the point, so the menu ends at `y`. */
    up?: boolean;
    children: ReactNode;
  },
) {
  const ref = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState({ left: props.x, top: props.y });
  useEscape(props.onClose);
  usePointerOutside(ref, props.onClose);

  // Runs after every render, since a list opening inside the menu changes its height.
  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    const y = props.up ? props.y - box.height : props.y;
    const left = Math.max(MARGIN, Math.min(props.x, window.innerWidth - box.width - MARGIN));
    const top = Math.max(MARGIN, Math.min(y, window.innerHeight - box.height - MARGIN));
    if (left !== at.left || top !== at.top) setAt({ left, top });
  });

  return createPortal(
    <div className="context-menu" ref={ref} style={at} role="menu" aria-label={props.label} data-escape-owner data-testid={props.testId}>
      {props.children}
    </div>,
    document.body,
  );
}
