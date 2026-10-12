import { useRef, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { findSlots, nextSlot } from '../shared/slots';

/** A text area that marks `{{slots}}`. Tab and ⇧Tab select the next and previous slot. */
export function SlotArea(props: {
  value: string;
  onChange: (value: string) => void;
  onKeyDown?: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  areaRef?: RefObject<HTMLTextAreaElement | null>;
  placeholder?: string;
  label: string;
  testId: string;
}) {
  const own = useRef<HTMLTextAreaElement>(null);
  const area = props.areaRef ?? own;
  const backdrop = useRef<HTMLDivElement>(null);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Tab' && !e.metaKey && !e.altKey && !e.ctrlKey) {
      const el = e.currentTarget;
      const slot = nextSlot(el.value, e.shiftKey ? el.selectionStart : el.selectionEnd, e.shiftKey);
      if (slot) {
        e.preventDefault();
        el.setSelectionRange(slot.start, slot.end);
        return;
      }
    }
    props.onKeyDown?.(e);
  };

  return (
    <div className="slot-area">
      <div className="backdrop" ref={backdrop} aria-hidden="true">
        {highlight(props.value)}
      </div>
      <textarea
        ref={area}
        data-testid={props.testId}
        aria-label={props.label}
        placeholder={props.placeholder}
        value={props.value}
        spellCheck
        onChange={(e) => props.onChange(e.target.value)}
        onScroll={(e) => {
          if (backdrop.current) backdrop.current.scrollTop = e.currentTarget.scrollTop;
        }}
        onKeyDown={onKeyDown}
      />
    </div>
  );
}

/** The text with slots marked. */
function highlight(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let pos = 0;
  for (const slot of findSlots(text)) {
    out.push(<span key={`p${pos}`}>{text.slice(pos, slot.start)}</span>);
    out.push(<mark key={`s${slot.start}`}>{text.slice(slot.start, slot.end)}</mark>);
    pos = slot.end;
  }
  out.push(<span key={`p${pos}`}>{text.slice(pos)}</span>);
  // A trailing newline needs a character after it to take up its line.
  out.push(<span key="end"> </span>);
  return out;
}
