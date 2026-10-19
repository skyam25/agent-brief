import { describe, expect, it } from 'vitest';
import { layoutGraph, nodeWidth } from './FeedbackGraph';

describe('graph layout', () => {
  it('widens nodes to the room, within bounds', () => {
    expect(nodeWidth(0)).toBe(116);
    expect(nodeWidth(900)).toBe(Math.round((900 - 6 - 90) / 4));
    expect(nodeWidth(4000)).toBe(280);
  });

  it('places columns by the node width', () => {
    const graph = { nodes: [{ id: 's', kind: 'source', label: 'S' }, { id: 'i', kind: 'item', label: 'I' }], edges: [] } as never;
    const { placed, width } = layoutGraph(graph, 200);
    expect(placed.get('i')!.x - placed.get('s')!.x).toBe(230);
    expect(width).toBe(4 + 4 * 200 + 3 * 30 + 2);
  });
});
