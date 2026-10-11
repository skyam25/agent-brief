/** The board host for the iPad client: HTTP for loading and Send, a WebSocket for live sync. */

import type { BoardEntry, BoardHost, SendPayload, Theme } from '../shared/ipc';

export class NotPairedError extends Error {}

/** Where Send goes, as the Mac last said. */
export interface Destination {
  sessionId: string;
  label: string;
}

/** localStorage is scoped to this origin, port included, so other services on the Mac never see the key. */
const CREDENTIAL_KEY = 'agent-brief-device';

function storedCredential(): string | undefined {
  try {
    return localStorage.getItem(CREDENTIAL_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Trades a `#pair=<code>` fragment for a device credential, stores it, and
 * takes the code out of the address bar. Without a fragment it does nothing.
 */
export async function pairFromLocation(): Promise<void> {
  const code = new URLSearchParams(location.hash.slice(1)).get('pair');
  if (!code) return;
  history.replaceState(null, '', location.pathname);
  const res = await fetch('/api/pair', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: code }),
  });
  const body = (await res.json().catch(() => ({}))) as { credential?: string; error?: string };
  if (!res.ok || !body.credential) throw new NotPairedError(body.error ?? `HTTP ${res.status}`);
  localStorage.setItem(CREDENTIAL_KEY, body.credential);
}

type RemoteFn = (board: string, elements: unknown[]) => void;

/** Base64 of bytes, in chunks so large PNGs do not overflow the call stack. */
function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export class WebHost implements BoardHost {
  private ws?: WebSocket;
  private board?: string;
  private remote: RemoteFn[] = [];
  private queued: unknown[] = [];
  private retry?: ReturnType<typeof setTimeout>;
  /** Called when this device's pairing is revoked or missing. */
  onUnpaired: () => void = () => {};
  /** Called when the live connection drops or comes back. */
  onConnection: (live: boolean) => void = () => {};
  /** Called when the Mac's chosen session changes. */
  onDestination: (destination: Destination | null) => void = () => {};
  /** Called with a message from the Mac, such as a full board. */
  onNotice: (text: string) => void = () => {};
  /** Where Send goes. Send names it, so a changed choice on the Mac is refused. */
  destination: Destination | null = null;

  private setDestination(destination: Destination | null): void {
    this.destination = destination;
    this.onDestination(destination);
  }

  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    const credential = storedCredential();
    if (!credential) {
      this.onUnpaired();
      throw new NotPairedError('This device is not paired with the Mac.');
    }
    const res = await fetch(path, {
      ...init,
      headers: { ...init?.headers, Authorization: `Bearer ${credential}` },
    });
    if (res.status === 401) {
      this.onUnpaired();
      throw new NotPairedError('This device is not paired with the Mac.');
    }
    const body = (await res.json().catch(() => ({}))) as T & { error?: string; destination?: Destination | null };
    if (body.destination !== undefined) this.setDestination(body.destination);
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    return body;
  }

  /** The board to open first: the Mac's current board when the server says, else the first one. */
  async startBoard(): Promise<string> {
    const r = await this.json<{ boards: { name: string }[]; current?: string }>('/api/boards');
    return r.current ?? r.boards[0]?.name ?? 'scratch';
  }

  async listBoards(): Promise<BoardEntry[]> {
    const r = await this.json<{ boards: { name: string; elementCount: number }[] }>('/api/boards');
    return r.boards.map((b) => ({ name: b.name, elementCount: b.elementCount, updatedAt: 0 }));
  }

  async loadBoard(name: string): Promise<{ scene: string | null; notes: string }> {
    const r = await this.json<{ elements: unknown[] }>(`/api/boards/${encodeURIComponent(name)}`);
    this.connect(name);
    return { scene: JSON.stringify({ type: 'excalidraw', elements: r.elements }), notes: '' };
  }

  // Changes travel over the WebSocket and the Mac saves them, so these do nothing here.
  async saveBoard(): Promise<void> {}
  async saveNotes(): Promise<void> {}

  async createBoard(): Promise<string> {
    throw new Error('Create boards on the Mac.');
  }

  async renameBoard(): Promise<string> {
    throw new Error('Rename boards on the Mac.');
  }

  async setCurrent(name: string): Promise<void> {
    this.connect(name);
  }

  async send(p: SendPayload): Promise<{ ok: boolean; message: string }> {
    try {
      const r = await this.json<{ to?: string }>('/api/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          board: p.boardName,
          png: base64(p.png),
          scene: p.scene,
          notes: p.notes,
          sessionId: this.destination?.sessionId,
        }),
      });
      return { ok: true, message: `Sent to ${r.to ?? "the Mac's Claude session"}` };
    } catch (err) {
      return { ok: false, message: `Send failed: ${(err as Error).message}` };
    }
  }

  onTheme(fn: (theme: Theme) => void): void {
    const media = matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', () => fn(media.matches ? 'dark' : 'light'));
  }

  theme(): Theme {
    return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  onRemoteElements(fn: RemoteFn): void {
    this.remote.push(fn);
  }

  pushElements(board: string, elements: unknown[]): void {
    if (board !== this.board) return;
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'update', board, elements }));
    else this.queued.push(...elements);
  }

  /** Opens the live connection for `board`, reconnecting after drops. */
  private connect(board: string): void {
    if (this.board === board && this.ws && this.ws.readyState <= WebSocket.OPEN) return;
    clearTimeout(this.retry);
    this.board = board;
    const old = this.ws;
    old?.close();
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?board=${encodeURIComponent(board)}`;
    // Browsers cannot set headers on a WebSocket, so the credential rides as a second subprotocol.
    const ws = new WebSocket(url, ['agent-brief', `auth.${storedCredential() ?? ''}`]);
    this.ws = ws;
    ws.onopen = () => {
      this.onConnection(true);
      if (this.queued.length) {
        ws.send(JSON.stringify({ type: 'update', board, elements: this.queued }));
        this.queued = [];
      }
    };
    ws.onmessage = (e) => {
      const msg = JSON.parse(String(e.data)) as
        | { type: 'destination'; destination: Destination | null }
        | { type: 'notice'; board: string; text: string }
        | { type: 'snapshot' | 'update'; board: string; elements: unknown[] };
      if (msg.type === 'destination') return this.setDestination(msg.destination);
      if (msg.board !== this.board) return;
      if (msg.type === 'notice') return this.onNotice(msg.text);
      for (const fn of this.remote) fn(msg.board, msg.elements);
    };
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.onConnection(false);
      if (e.code === 4001) return this.onUnpaired();
      this.retry = setTimeout(() => this.connect(board), 1000);
    };
  }
}
