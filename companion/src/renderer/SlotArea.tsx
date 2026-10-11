import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { findSlots, nextSlot, slashQuery } from '../shared/slots';
import type { Template } from '../shared/ipc';

const MAX_MATCHES = 8;

/**
 * Puts the cursor in a text area and selects its first slot. Waits a few
 * frames for React to show the area, since a new draft renders after this call.
 */
export function focusFirstSlot(testId: string, frames = 10): void {
  requestAnimationFrame(() => {
    const el = document.querySelector<HTMLTextAreaElement>(`[data-testid="${testId}"]`);
    const slot = el && nextSlot(el.value, 0);
    if (!el || !slot) {
      if (frames > 0) focusFirstSlot(testId, frames - 1);
      else el?.focus();
      return;
    }
    el.focus();
    el.setSelectionRange(slot.start, slot.end);
  });
}

interface Picker {
  start: number;
  query: string;
  index: number;
}

/**
 * A text area that marks `{{slots}}`. Tab and ⇧Tab select the next and previous slot.
 * With `templates`, a `/` at the start of a line opens a menu that inserts one.
 */
export function SlotArea(props: {
  value: string;
  onChange: (value: string) => void;
  onKeyDown?: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  areaRef?: RefObject<HTMLTextAreaElement | null>;
  templates?: Template[];
  placeholder?: string;
  label: string;
  testId: string;
}) {
  const own = useRef<HTMLTextAreaElement>(null);
  const area = props.areaRef ?? own;
  const backdrop = useRef<HTMLDivElement>(null);
  const marker = useRef<HTMLSpanElement>(null);
  const [picker, setPicker] = useState<Picker>();
  const [menuTop, setMenuTop] = useState(0);
  /** A line whose menu was closed with Escape stays closed until its slash goes. */
  const dismissed = useRef<number>(undefined);
  const pendingSelection = useRef<[number, number]>(undefined);

  const matches = picker
    ? (props.templates ?? [])
        .filter((t) => `${t.title} ${t.id}`.toLowerCase().includes(picker.query.trim().toLowerCase()))
        .slice(0, MAX_MATCHES)
    : [];

  useLayoutEffect(() => {
    const sel = pendingSelection.current;
    if (!sel || !area.current) return;
    pendingSelection.current = undefined;
    area.current.focus();
    area.current.setSelectionRange(sel[0], sel[1]);
  }, [props.value, area]);

  useLayoutEffect(() => {
    if (!picker || !marker.current || !backdrop.current) return;
    const line = parseFloat(getComputedStyle(backdrop.current).lineHeight) || 22;
    setMenuTop(marker.current.offsetTop - backdrop.current.scrollTop + line + 4);
  }, [picker, props.value]);

  /** Opens or closes the template menu from where the cursor is. */
  const track = (text: string, caret: number) => {
    if (!props.templates) return;
    const q = slashQuery(text, caret);
    if (!q || q.start !== dismissed.current) dismissed.current = undefined;
    if (!q || q.start === dismissed.current) return setPicker(undefined);
    setPicker((p) => ({ ...q, index: p && p.start === q.start ? p.index : 0 }));
  };

  const insert = (t: Template) => {
    if (!picker || !area.current) return;
    const caret = area.current.selectionStart;
    const text = props.value.slice(0, picker.start) + t.body + props.value.slice(caret);
    const slot = findSlots(text).find((s) => s.start >= picker.start && s.end <= picker.start + t.body.length);
    pendingSelection.current = slot ? [slot.start, slot.end] : [picker.start + t.body.length, picker.start + t.body.length];
    setPicker(undefined);
    props.onChange(text);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (picker) {
      if (e.key === 'Escape') {
        e.preventDefault();
        dismissed.current = picker.start;
        setPicker(undefined);
        return;
      }
      if (matches.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 1 : -1;
        setPicker({ ...picker, index: (picker.index + step + matches.length) % matches.length });
        return;
      }
      if (matches.length && (e.key === 'Enter' || e.key === 'Tab') && !e.metaKey) {
        e.preventDefault();
        insert(matches[Math.min(picker.index, matches.length - 1)]);
        return;
      }
    }
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
        {highlight(props.value, picker?.start, marker)}
      </div>
      <textarea
        ref={area}
        data-testid={props.testId}
        aria-label={props.label}
        placeholder={props.placeholder}
        value={props.value}
        spellCheck
        onChange={(e) => {
          props.onChange(e.target.value);
          track(e.target.value, e.target.selectionStart);
        }}
        onSelect={(e) => track(e.currentTarget.value, e.currentTarget.selectionStart)}
        onBlur={() => setPicker(undefined)}
        onScroll={(e) => {
          if (backdrop.current) backdrop.current.scrollTop = e.currentTarget.scrollTop;
        }}
        onKeyDown={onKeyDown}
      />
      {picker && (
        <div className="slash-menu" style={{ top: menuTop }} role="listbox" aria-label="Templates" data-escape-owner data-testid="slash-menu">
          {matches.length === 0 ? (
            <p className="muted">No template matches “{picker.query}”.</p>
          ) : (
            matches.map((t, i) => (
              <div
                key={t.id}
                role="option"
                aria-selected={i === picker.index}
                onMouseDown={(e) => {
                  e.preventDefault();
                  insert(t);
                }}
                data-testid="slash-item"
              >
                <span>{t.title}</span>
                <span className="muted">{t.body.split('\n').find((l) => l.trim())}</span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

/** The text with slots marked, plus a marker where the template menu hangs. */
function highlight(text: string, markerAt: number | undefined, marker: RefObject<HTMLSpanElement | null>): ReactNode[] {
  const out: ReactNode[] = [];
  let pos = 0;
  const plain = (to: number) => {
    if (markerAt !== undefined && markerAt >= pos && markerAt < to) {
      out.push(<span key={`a${pos}`}>{text.slice(pos, markerAt)}</span>, <span key="marker" ref={marker} />);
      pos = markerAt;
    }
    out.push(<span key={`p${pos}`}>{text.slice(pos, to)}</span>);
    pos = to;
  };
  for (const slot of findSlots(text)) {
    plain(slot.start);
    out.push(<mark key={`s${slot.start}`}>{text.slice(slot.start, slot.end)}</mark>);
    pos = slot.end;
  }
  plain(text.length);
  // A trailing newline needs a character after it to take up its line.
  out.push(<span key="end"> </span>);
  return out;
}
