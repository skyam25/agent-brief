/** A menu at the pointer, for a right-click. It stays on screen near the window's edges. */

import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useEscape, usePointerOutside } from './hooks';

const MARGIN = 8;

export interface MenuPoint {
  x: number;
  y: number;
}

export function ContextMenu(props: MenuPoint & { label: string; testId: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState({ left: props.x, top: props.y });
  useEscape(props.onClose);
  usePointerOutside(ref, props.onClose);

  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    setAt({
      left: Math.max(MARGIN, Math.min(props.x, window.innerWidth - box.width - MARGIN)),
      top: Math.max(MARGIN, Math.min(props.y, window.innerHeight - box.height - MARGIN)),
    });
  }, [props.x, props.y]);

  return createPortal(
    <div className="context-menu" ref={ref} style={at} role="menu" aria-label={props.label} data-escape-owner data-testid={props.testId}>
      {props.children}
    </div>,
    document.body,
  );
}
