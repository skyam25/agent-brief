import type {
  BoardsResponse,
  ElementSummary,
  Health,
  ReadResponse,
  SessionsResponse,
} from '../src/protocol';

const n = (v: number) => String(Math.round(v));

function element(e: ElementSummary): string {
  const parts: string[] = [e.id, e.type];
  if (e.label) parts.push(JSON.stringify(e.label));
  if (e.type === 'arrow' || e.type === 'line') {
    if (e.startId || e.endId) parts.push(`${e.startId ?? '?'} → ${e.endId ?? '?'}`);
    else parts.push(`at ${n(e.x)},${n(e.y)} ${n(e.width)}×${n(e.height)}`);
  } else {
    parts.push(`at ${n(e.x)},${n(e.y)} ${n(e.width)}×${n(e.height)}`);
  }
  if (e.color) parts.push(e.color);
  parts.push(`(${e.by})`);
  return parts.join(' ');
}

/** Compact text view of a board. Frame children sit under their frame. */
export function formatRead(r: ReadResponse): string {
  const { bounds: b } = r;
  const count = r.elements.length;
  const lines = [
    `board ${JSON.stringify(r.board)} · ${count} element${count === 1 ? '' : 's'} · bounds ${n(b.x)},${n(b.y)} ${n(b.width)}×${n(b.height)}`,
  ];
  const ids = new Set(r.elements.map((e) => e.id));
  const children = new Map<string, ElementSummary[]>();
  for (const e of r.elements) {
    if (e.frameId && ids.has(e.frameId)) {
      const list = children.get(e.frameId) ?? [];
      list.push(e);
      children.set(e.frameId, list);
    }
  }
  const emit = (e: ElementSummary, depth: number) => {
    lines.push('  '.repeat(depth) + element(e));
    for (const child of children.get(e.id) ?? []) emit(child, depth + 1);
  };
  for (const e of r.elements) {
    if (!(e.frameId && ids.has(e.frameId))) emit(e, 0);
  }
  return lines.join('\n');
}

export function formatStatus(h: Health): string {
  return `Agent Brief running · pid ${h.pid} · protocol v${h.version} · panel ${h.panelVisible ? 'visible' : 'hidden'} · current board ${JSON.stringify(h.currentBoard)}`;
}

export function formatSessions(r: SessionsResponse): string {
  if (r.sessions.length === 0) return 'no sessions registered';
  return r.sessions
    .map((s) => {
      const mark = s.sessionId === r.targetSessionId ? '*' : ' ';
      const title = s.title ? `  ${JSON.stringify(s.title)}` : '';
      return `${mark} ${s.sessionId}  ${s.cwd}${title}`;
    })
    .join('\n');
}

export function formatBoards(r: BoardsResponse): string {
  if (r.boards.length === 0) return 'no boards';
  return r.boards
    .map((b) => {
      const mark = b.name === r.current ? '*' : ' ';
      const count = `${b.elementCount} element${b.elementCount === 1 ? '' : 's'}`;
      return `${mark} ${b.name}  ${count}  updated ${new Date(b.updatedAt).toISOString()}`;
    })
    .join('\n');
}
