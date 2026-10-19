/** Find on the page under review. The page's overlay script matches and highlights; this bar asks and shows the count. */

import { useEffect, useRef, useState, type RefObject } from 'react';
import { isTagged, type FromPage, type ToPage } from '../review/messages';
import { FindField, type FindCount } from './FindField';

/** The last query, so the bar opens with it again. */
let lastQuery = '';

export function PageFind(props: {
  frame: RefObject<HTMLIFrameElement | null>;
  post: (m: ToPage) => void;
  /** A new value takes focus and selects the query. */
  focusKey: number;
  onClose: () => void;
}) {
  const { frame, post } = props;
  const input = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(lastQuery);
  const [count, setCount] = useState<FindCount>({ total: 0, current: -1 });
  const query = useRef(value);
  query.current = value;

  // The page answers each search with a count. A reloaded page searches again.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow || !isTagged(e.data)) return;
      const m = e.data as unknown as FromPage;
      if (m.type === 'found') setCount({ total: m.total, current: m.current });
      if (m.type === 'ready') post({ type: 'find', query: query.current });
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [frame, post]);

  useEffect(() => {
    post({ type: 'find', query: query.current });
    return () => post({ type: 'find', query: '' });
  }, [post]);

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, [props.focusKey]);

  return (
    <FindField
      label="Find on page"
      value={value}
      count={count}
      inputRef={input}
      onChange={(next) => {
        setValue(next);
        lastQuery = next;
        post({ type: 'find', query: next });
      }}
      onStep={(dir) => post({ type: 'find-step', dir })}
      onClose={props.onClose}
    />
  );
}
