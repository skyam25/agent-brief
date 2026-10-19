/**
 * The project's feedback as a layered graph: sources, items, outputs and workspaces
 * in four columns, with the edges between them. Clicking an item opens it in the list.
 */

import { useEffect, useRef, useState } from 'react';
import type { FeedbackGraph as Graph, FeedbackGraphNode } from '../protocol';
import type { CompanionApi } from '../shared/ipc';

export type GraphHost = Pick<CompanionApi, 'listFeedback' | 'onFeedbackChanged'>;

const COLUMNS = [
  { kind: 'source', title: 'Sources' },
  { kind: 'item', title: 'Items' },
  { kind: 'output', title: 'Outputs' },
  { kind: 'workspace', title: 'Workspaces' },
] as const;
const NODE_W = 116;
const MAX_NODE_W = 280;
const GAP = 30;
const NODE_H = 24;
const ROW = 32;
const HEAD = 22;
const LEFT = 4;
/** Average width of a label character at 11 px. */
const CHAR_W = 5.5;

/** Nodes widen to fill the room, from NODE_W up to MAX_NODE_W. */
export const nodeWidth = (room: number) => Math.round(Math.min(MAX_NODE_W, Math.max(NODE_W, (room - LEFT - 2 - (COLUMNS.length - 1) * GAP) / COLUMNS.length)));

const cut = (s: string, w: number) => {
  const chars = Math.floor((w - 16) / CHAR_W);
  return s.length > chars ? `${s.slice(0, chars - 1)}…` : s;
};

interface Placed {
  node: FeedbackGraphNode;
  x: number;
  y: number;
}

/** Each column in order. Items keep the file order; the other columns sit near the items they link. */
export function layoutGraph(graph: Graph, w = NODE_W): { placed: Map<string, Placed>; width: number; height: number } {
  const items = graph.nodes.filter((n) => n.kind === 'item');
  const rank = new Map(items.map((n, i) => [n.id, i]));
  const near = (id: string) => {
    const linked = graph.edges.flatMap((e) => (e.from === id ? [e.to] : e.to === id ? [e.from] : [])).filter((x) => rank.has(x));
    return linked.length ? linked.reduce((sum, x) => sum + rank.get(x)!, 0) / linked.length : Infinity;
  };
  const placed = new Map<string, Placed>();
  let rows = 0;
  COLUMNS.forEach((col, c) => {
    const nodes = graph.nodes.filter((n) => n.kind === col.kind);
    const order = col.kind === 'item' ? nodes : nodes.map((n, i) => ({ n, i, at: near(n.id) })).sort((a, b) => a.at - b.at || a.i - b.i).map((x) => x.n);
    order.forEach((node, r) => placed.set(node.id, { node, x: LEFT + c * (w + GAP), y: HEAD + r * ROW }));
    rows = Math.max(rows, order.length);
  });
  return { placed, width: LEFT + COLUMNS.length * w + (COLUMNS.length - 1) * GAP + 2, height: HEAD + Math.max(rows, 1) * ROW };
}

function edgePath(a: Placed, b: Placed, kind: string, w: number): string {
  const y1 = a.y + NODE_H / 2;
  const y2 = b.y + NODE_H / 2;
  if (kind === 'related') {
    // Item to item in one column: an arc out to the right of the column and back.
    const x = a.x + w;
    const bend = Math.min(GAP - 4, 8 + Math.abs(y2 - y1) / 6);
    return `M${x},${y1} C${x + bend},${y1} ${x + bend},${y2} ${x},${y2}`;
  }
  const x1 = a.x + w;
  const x2 = b.x;
  const mid = (x1 + x2) / 2;
  return `M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`;
}

export function FeedbackGraph(props: {
  host: GraphHost;
  sessionId?: string;
  output?: string;
  /** A change reads the files again. */
  reads?: number;
  onOpenItem: (output: string, n: number) => void;
}) {
  const [graph, setGraph] = useState<Graph>();
  const [error, setError] = useState<string>();
  const [truncated, setTruncated] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState(0);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setRoom(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [!!graph?.nodes.length]);
  useEffect(() => {
    if (!props.sessionId) return;
    let gone = false;
    const load = () =>
      void props.host
        .listFeedback(props.sessionId!)
        .then((p) => {
          if (gone) return;
          setGraph(p.graph ?? { nodes: [], edges: [] });
          setTruncated(!!p.truncated);
          setError(undefined);
        })
        .catch((err: Error) => !gone && setError(err.message));
    load();
    const off = props.host.onFeedbackChanged(load);
    return () => {
      gone = true;
      off();
    };
  }, [props.host, props.sessionId, props.reads]);

  if (error) return <p role="alert" className="behavior-error">{error}</p>;
  if (!graph) return <p>Loading the graph…</p>;
  if (!graph.nodes.length) return <p className="muted">No feedback files in this project yet.</p>;
  const w = nodeWidth(room);
  const { placed, width, height } = layoutGraph(graph, w);

  return (
    <div className="feedback-graph" ref={box} data-testid="feedback-graph">
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Feedback graph">
        {COLUMNS.map((col, c) => (
          <text key={col.kind} className="graph-head" x={LEFT + c * (w + GAP)} y={12}>
            {col.title}
          </text>
        ))}
        {graph.edges.map((e, i) => {
          const a = placed.get(e.from);
          const b = placed.get(e.to);
          if (!a || !b) return null;
          return <path key={i} className={`graph-edge ${e.kind.replace(' ', '-')}`} d={edgePath(a, b, e.kind, w)} data-testid="graph-edge" data-kind={e.kind} />;
        })}
        {[...placed.values()].map(({ node, x, y }) => {
          const open = node.kind === 'item' && !node.missing ? () => props.onOpenItem(node.output!, node.n!) : undefined;
          const here = node.output === props.output && (node.kind === 'item' || node.kind === 'output');
          const cls = ['graph-node', node.kind, node.state ?? '', node.missing ? 'missing' : '', here ? 'here' : '', open ? 'link' : ''].filter(Boolean).join(' ');
          return (
            <g
              key={node.id}
              className={cls}
              transform={`translate(${x},${y})`}
              onClick={open}
              role={open ? 'button' : undefined}
              tabIndex={open ? 0 : undefined}
              aria-label={open ? `Open ${node.label} in ${node.output}` : undefined}
              onKeyDown={open ? (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), open()) : undefined}
              data-testid="graph-node"
              data-id={node.id}
            >
              <title>{node.detail ?? node.label}</title>
              <rect width={w} height={NODE_H} rx={6} />
              <text x={8} y={NODE_H / 2 + 4}>
                {cut(node.label, w)}
              </text>
            </g>
          );
        })}
      </svg>
      {truncated && <p className="muted">The scan stopped early, so some files are not shown.</p>}
    </div>
  );
}
