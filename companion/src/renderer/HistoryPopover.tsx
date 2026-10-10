import { useEffect, useRef, useState } from 'react';
import type { CompanionApi, HistoryEntry } from '../shared/ipc';

type Item = HistoryEntry & { url?: string };

function when(ms: number): string {
  const d = new Date(ms);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}

/** The last sends. Open puts one on a new board; Copy puts its prompt on the clipboard. */
export function HistoryPopover(props: {
  host: CompanionApi;
  onOpen: (id: string) => void;
  onClose: () => void;
}) {
  const [items, setItems] = useState<Item[]>();
  const [copied, setCopied] = useState<string>();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const urls: string[] = [];
    void props.host.listHistory().then((list) => {
      const withUrls = list.map(({ png, ...e }) => {
        if (!png) return e;
        const url = URL.createObjectURL(new Blob([png as BlobPart], { type: 'image/png' }));
        urls.push(url);
        return { ...e, url };
      });
      setItems(withUrls);
    });
    return () => {
      for (const u of urls) URL.revokeObjectURL(u);
    };
  }, [props.host]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const anchor = ref.current?.parentElement;
      if (anchor && !anchor.contains(e.target as Node)) props.onClose();
    };
    window.addEventListener('pointerdown', onDown, { capture: true });
    return () => window.removeEventListener('pointerdown', onDown, { capture: true });
  }, [props]);

  const copy = async (item: Item) => {
    await navigator.clipboard.writeText(item.draft);
    setCopied(item.id);
  };

  return (
    <div className="popover-panel history" ref={ref} role="dialog" aria-label="History" data-testid="history">
      {items?.length === 0 && <p className="muted">Nothing sent yet. The last 10 sends show up here.</p>}
      <ul>
        {items?.map((item) => (
          <li key={item.id} data-testid="history-item">
            {item.url ? <img src={item.url} alt="" /> : <div className="thumb" />}
            <div className="meta">
              <span>{item.board}</span>
              <span className="muted">
                {when(item.sentAt)} · {item.target}
              </span>
            </div>
            <div className="actions">
              <button className="ghost small" title="Open on a new board" onClick={() => props.onOpen(item.id)} data-testid="history-open">
                Open
              </button>
              <button className="ghost small" title="Copy the prompt" onClick={() => void copy(item)} data-testid="history-copy">
                {copied === item.id ? 'Copied' : 'Copy'}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
