import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { usePointerOutside, useEscape } from './hooks';
import { MoreIcon, TrashIcon } from './Icons';

/** A button whose menu opens upward, for the editor's footer. `trigger` draws the button. */
export function FooterMenu(props: {
  trigger: (open: boolean, toggle: () => void) => ReactNode;
  className?: string;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  usePointerOutside(ref, close, { active: open });
  return (
    <div className="anchor" ref={ref}>
      {props.trigger(open, () => setOpen((o) => !o))}
      {open && (
        <MoreMenuPanel onClose={close} className={props.className}>
          {props.children(close)}
        </MoreMenuPanel>
      )}
    </div>
  );
}

/** A ⋯ button whose menu opens upward. */
export function MoreMenu(props: { label: string; testId: string; children: (close: () => void) => ReactNode }) {
  return (
    <FooterMenu
      trigger={(open, toggle) => (
        <button
          className="ghost icon-button"
          aria-label={props.label}
          title={props.label}
          aria-haspopup="menu"
          aria-pressed={open}
          onClick={toggle}
          data-testid={props.testId}
        >
          <MoreIcon />
        </button>
      )}
    >
      {props.children}
    </FooterMenu>
  );
}

function MoreMenuPanel(props: { onClose: () => void; children: ReactNode; className?: string }) {
  useEscape(props.onClose);
  return (
    <div className={`popover-panel more-menu up${props.className ? ` ${props.className}` : ''}`} role="menu" data-escape-owner>
      {props.children}
    </div>
  );
}

/** A menu item that asks once more before it deletes, then reverts after a few seconds. */
export function DeleteItem(props: { what: string; onDelete: () => void; testId: string }) {
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    if (!confirm) return;
    const timer = setTimeout(() => setConfirm(false), 3000);
    return () => clearTimeout(timer);
  }, [confirm]);
  return (
    <button className="ghost danger" role="menuitem" onClick={() => (confirm ? props.onDelete() : setConfirm(true))} data-testid={props.testId}>
      <TrashIcon />
      {confirm ? 'Click again to delete' : `Delete ${props.what}`}
    </button>
  );
}
