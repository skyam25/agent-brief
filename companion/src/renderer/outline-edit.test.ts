import { describe, expect, it, vi } from 'vitest';
import type { OutlineDoc, OutlinePoint, OutlineSection } from '../protocol';
import {
  acceptedDirection,
  addPendingOp,
  citeLabel,
  citesWith,
  citeTitle,
  directionHeadline,
  dropPending,
  intentOp,
  intentRows,
  kindFor,
  leavesRow,
  oneLine,
  openableRef,
  pointMoveOp,
  pointTextOp,
  resolvePending,
  sectionRows,
  shownChanges,
  sourceLine,
  writeWithRetry,
  type PendingPoint,
} from './outline-edit';

const point = (id: string, text = id): OutlinePoint => ({ id, kind: 'point', text, cites: [] });
const section = (id: string, ...points: string[]): OutlineSection => ({ id, title: id, points: points.map((p) => point(p)) });
const rowIds = (s: OutlineSection, pending: PendingPoint[]) => sectionRows(s, pending).map((r) => (r.kind === 'point' ? r.point.id : r.pending.key));

describe('cite chips', () => {
  it('labels by mark and keeps details in the title', () => {
    expect(citeLabel({ source: 'S1', mark: 'supports' })).toBe('S1 ✓');
    expect(citeLabel({ source: 'S2', mark: 'partly' })).toBe('S2 ~');
    expect(citeLabel({ source: 'S3' })).toBe('S3');
    expect(citeTitle({ source: 'S2', location: 'p.3', mark: 'partly', note: '12 accounts only' }, 'Pilot readout')).toBe('S2 · Pilot readout · p.3 · partly · 12 accounts only');
    expect(citeTitle({ source: 'S1' })).toBe('S1 · unchecked');
  });

  it('replaces or removes a cite, and drops a note without a mark', () => {
    const cites = [{ source: 'S1', mark: 'supports' as const }, { source: 'S2' }];
    expect(citesWith(cites, 1, { source: 'S2', location: ' p.3 ', note: 'why' })).toEqual([{ source: 'S1', mark: 'supports' }, { source: 'S2', location: 'p.3' }]);
    expect(citesWith(cites, 0)).toEqual([{ source: 'S2' }]);
  });
});

describe('source refs', () => {
  it('opens web links and project paths, not boards or other schemes', () => {
    expect(openableRef('https://files.slack.com/files-pri/T1/x')).toBe(true);
    expect(openableRef('08-evidence/meetings/2026-10-08.md')).toBe(true);
    expect(openableRef('board:velocity')).toBe(false);
    expect(openableRef('file:///etc/hosts')).toBe(false);
    expect(openableRef('  ')).toBe(false);
    expect(openableRef(undefined)).toBe(false);
  });
});

describe('point edits', () => {
  it('edits text, and a leading Open: makes an open point', () => {
    expect(pointTextOp(point('p1', 'old'), ' new  text ')).toEqual({ op: 'editPoint', id: 'p1', text: 'new text' });
    expect(pointTextOp(point('p1', 'old'), 'Open: who pays?')).toEqual({ op: 'editPoint', id: 'p1', text: 'who pays?', kind: 'open' });
    expect(pointTextOp(point('p1', 'old'), 'old')).toBeUndefined();
    expect(pointTextOp(point('p1', 'old'), '   ')).toBeUndefined();
  });

  it('moves within a section and across its edges', () => {
    const doc = { sections: [section('s1', 'a', 'b', 'c'), section('s2', 'd')] };
    expect(pointMoveOp(doc, 'b', 1)).toEqual({ op: 'movePoint', id: 'b', section: 's1', after: 'c' });
    expect(pointMoveOp(doc, 'b', -1)).toEqual({ op: 'movePoint', id: 'b', section: 's1', after: null });
    expect(pointMoveOp(doc, 'c', -1)).toEqual({ op: 'movePoint', id: 'c', section: 's1', after: 'a' });
    expect(pointMoveOp(doc, 'c', 1)).toEqual({ op: 'movePoint', id: 'c', section: 's2', after: null });
    expect(pointMoveOp(doc, 'd', -1)).toEqual({ op: 'movePoint', id: 'd', section: 's1', after: 'c' });
    expect(pointMoveOp(doc, 'a', -1)).toBeUndefined();
    expect(pointMoveOp(doc, 'd', 1)).toBeUndefined();
  });
});

describe('intent rows', () => {
  it('offers the usual keys and writes the whole intent without blanks', () => {
    const intent = [{ key: 'Goal', text: 'decide' }, { key: 'Budget', text: 'none' }];
    expect(intentRows(intent).map((l) => l.key)).toEqual(['Goal', 'Budget', 'Reader', 'Message', 'Guide']);
    expect(intentOp(intent, 'Reader', 'the CRO')).toEqual({ op: 'setIntent', lines: [...intent, { key: 'Reader', text: 'the CRO' }] });
    expect(intentOp(intent, 'Goal', ' ')).toEqual({ op: 'setIntent', lines: [{ key: 'Budget', text: 'none' }] });
    expect(intentOp(intent, 'Goal', 'decide')).toBeUndefined();
  });

  it('guesses the kind from the target', () => {
    expect(kindFor('site/checkout.html')).toBe('page');
    expect(kindFor('docs/memo.md')).toBe('document');
    expect(kindFor(' ')).toBeUndefined();
  });
});

describe('pending rows', () => {
  const s = section('s1', 'p1', 'p2');

  it('slot in after what they follow, chained ones in order', () => {
    const pending: PendingPoint[] = [
      { key: 'n1', section: 's1', after: { id: 'p1' } },
      { key: 'n2', section: 's1', after: { key: 'n1' } },
      { key: 'n3', section: 's1', after: { id: null } },
      { key: 'n4', section: 's2', after: { id: null } },
    ];
    expect(rowIds(s, pending)).toEqual(['n3', 'p1', 'n1', 'n2', 'p2']);
  });

  it('go last when their anchor is gone', () => {
    expect(rowIds(s, [{ key: 'n1', section: 's1', after: { id: 'p9' } }])).toEqual(['p1', 'p2', 'n1']);
  });

  it('hand their place on when written or dropped', () => {
    const pending: PendingPoint[] = [
      { key: 'n1', section: 's1', after: { id: 'p1' } },
      { key: 'n2', section: 's1', after: { key: 'n1' } },
    ];
    expect(resolvePending(pending, 'n1', 'p3')).toEqual([{ key: 'n2', section: 's1', after: { id: 'p3' } }]);
    expect(dropPending(pending, 'n1')).toEqual([{ key: 'n2', section: 's1', after: { id: 'p1' } }]);
  });

  it('add after a written point, or last while following an unwritten one', () => {
    expect(addPendingOp({ key: 'n1', section: 's1', after: { id: 'p1' } }, 'Open: who?')).toEqual({ op: 'addPoint', section: 's1', text: 'who?', kind: 'open', after: 'p1' });
    expect(addPendingOp({ key: 'n1', section: 's1', after: { id: null } }, 'first')).toEqual({ op: 'addPoint', section: 's1', text: 'first', after: null });
    expect(addPendingOp({ key: 'n2', section: 's1', after: { key: 'n1' } }, 'x')).toEqual({ op: 'addPoint', section: 's1', text: 'x' });
    expect(addPendingOp({ key: 'n1', section: 's1', after: { id: 'p1' } }, ' ')).toBeUndefined();
  });
});

describe('direction', () => {
  const doc: Pick<OutlineDoc, 'target' | 'kind' | 'direction'> = {
    target: 'docs/memo.md',
    kind: 'document',
    direction: { date: '2026-10-25', state: 'proposed', scope: 'regenerate', from: '3 comments on docs/memo.md', bullets: ['a'], changes: ['b'] },
  };

  it('names where it came from', () => {
    expect(directionHeadline(doc)).toBe('Direction from 3 comments on docs/memo.md. Claude has not changed it yet.');
    expect(directionHeadline({ kind: 'page', direction: { ...doc.direction!, from: undefined } })).toBe('Claude proposed a direction on 2026-10-25. Claude has not changed the page yet.');
  });

  it('accepts at a scope and keeps the rest', () => {
    expect(acceptedDirection(doc, 'edit')).toEqual({ op: 'setDirection', direction: { ...doc.direction, state: 'accepted', scope: 'edit' } });
    expect(acceptedDirection({}, 'edit')).toBeUndefined();
  });
});

describe('writeWithRetry', () => {
  it('reads again and writes the same ops once on a stale version', async () => {
    const read = vi.fn(async () => 'v2');
    const write = vi.fn(async (v: string) => {
      if (v === 'v1') throw new Error("Error invoking remote method 'outline:update': Error: The outline changed since you read it");
      return v;
    });
    await expect(writeWithRetry('v1', read, write)).resolves.toBe('v2');
    expect(write.mock.calls.map((c) => c[0])).toEqual(['v1', 'v2']);
  });

  it('gives up after one retry and on other errors', async () => {
    const stale = async () => {
      throw new Error('changed since');
    };
    await expect(writeWithRetry('v1', async () => 'v2', stale)).rejects.toThrow('changed since');
    const write = vi.fn(async () => {
      throw new Error('ops[0] editPoint: There is no point p9');
    });
    await expect(writeWithRetry('v1', async () => 'v2', write)).rejects.toThrow('no point p9');
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('reads first when it has no version', async () => {
    const write = vi.fn(async (v: string) => v);
    await expect(writeWithRetry(undefined, async () => 'v3', write)).resolves.toBe('v3');
  });
});

describe('wrapped fields', () => {
  it('turns pasted line breaks into spaces', () => {
    expect(oneLine('one\ntwo\r\nthree\rfour')).toBe('one two three four');
  });

  it('leaves the row only from the first line up or the last line down', () => {
    const tops = (caret: number) => ({ caret, first: 4, last: 40 });
    expect(leavesRow(-1, tops(4))).toBe(true);
    expect(leavesRow(-1, tops(22))).toBe(false);
    expect(leavesRow(1, tops(22))).toBe(false);
    expect(leavesRow(1, tops(40))).toBe(true);
    expect(leavesRow(1, { caret: 4, first: 4, last: 4 })).toBe(true);
  });
});

describe('source line', () => {
  it('names the outline when the file has one', () => {
    expect(sourceLine('docs/memo.md')).toBe('From docs/memo.md. Send asks Claude to apply your changes to the file.');
    expect(sourceLine('docs/memo.md', 'docs/memo.outline.md')).toBe(
      'From docs/memo.md. Send folds your comments into docs/memo.outline.md first, and Claude proposes a direction there.',
    );
  });
});

describe('direction changes', () => {
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `change ${i + 1}`);

  it('shows four and counts the rest until expanded', () => {
    expect(shownChanges(lines(3), false)).toEqual({ shown: lines(3), more: 0 });
    expect(shownChanges(lines(4), false)).toEqual({ shown: lines(4), more: 0 });
    expect(shownChanges(lines(14), false)).toEqual({ shown: lines(4), more: 10 });
    expect(shownChanges(lines(14), true)).toEqual({ shown: lines(14), more: 0 });
  });
});
