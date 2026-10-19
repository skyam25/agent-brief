import { describe, expect, it } from 'vitest';
import { cleanName } from '../main/store';
import { parseFeedback } from './feedback';
import {
  bindingOf,
  boundTo,
  fitSnapshot,
  isWorkspaceNotes,
  latestWorkspace,
  outputStem,
  railEntries,
  seedRequest,
  shortDate,
  workspaceBinding,
  workspaceBoardName,
  workspacePng,
  workspaceQuote,
  workspaceRound,
  workspaceSummary,
} from './feedback-workspace';

const FILE = `# Feedback · checkout.html

## Round 2 · SME · 2026-10-18
## Round 1 · customers · 2026-10-12

- [ ] #6 Hard to find the filters
    Round: 1
    Src: 1 · Ana · 03:02 · "Where do I filter?"
    Change: Move the filter row above the results.
    Where: #filters
    Claude: 2026-10-12 · cataloged
    You: 2026-10-12 · accept · keep it sticky
    You: 2026-10-13 · note · check mobile too
    a loose note
    You: 2026-10-14 · voice · the chips wrap badly
    Workspace: 2026-10-15 · saved · fb-checkout-6 · checkout.html.feedback/6-workspace.png
    Review: 2026-10-16 · pin 2 · "reads better"
    You: 2026-10-17 · pin · sticky “Option B” · make it bigger
    Src: 2 · Maya · 00:14 · "I couldn't find the filters"
    Workspace: 2026-10-18 · saved · fb-checkout-6 · checkout.html.feedback/6-workspace.png
`;

const item = () => parseFeedback(FILE).items[0]!;
const empty = { elements: [], bounds: { x: 0, y: 0, width: 0, height: 0 } };

describe('workspace board names', () => {
  it('names the board after the output stem and the item', () => {
    expect(workspaceBoardName('prototype/checkout.html', 6)).toBe('fb-checkout-6');
    expect(workspaceBoardName('docs/prd.v2.md', 3)).toBe('fb-prd.v2-3');
    expect(workspaceBoardName('checkout.html', 6, 2)).toBe('fb-checkout-6-2');
    expect(workspacePng(6, 3)).toBe('6-workspace-3.png');
  });

  it('makes any file name safe and short enough for a board', () => {
    expect(outputStem('My Plan (v2)!.md')).toBe('My-Plan-v2');
    expect(outputStem('.env')).toBe('env');
    expect(outputStem('###.html')).toBe('output');
    const long = workspaceBoardName(`${'a'.repeat(120)}.html`, 1234, 12);
    expect(long).toHaveLength(64);
    expect(long.endsWith('-1234-12')).toBe(true);
    for (const name of [long, workspaceBoardName('My Plan (v2)!.md', 1), workspaceBoardName('über/Ünïcode ✓.html', 2)]) expect(cleanName(name)).toBe(name);
  });

  it('ties a board to one item of one output through its notes', () => {
    const notes = `${workspaceBinding('/p/checkout.html', 6)}\nanything else`;
    expect(boundTo(notes, '/p/checkout.html', 6)).toBe(true);
    expect(boundTo(notes, '/q/checkout.html', 6)).toBe(false);
    expect(boundTo(notes, '/p/checkout.html', 7)).toBe(false);
    expect(boundTo('', '/p/checkout.html', 6)).toBe(false);
    expect(bindingOf(notes)).toEqual({ outputFile: '/p/checkout.html', n: 6 });
  });

  it('marks a workspace by its binding, never by its name', () => {
    expect(isWorkspaceNotes(`${workspaceBinding('/p/a b.html', 2)}\n`)).toBe(true);
    expect(isWorkspaceNotes('')).toBe(false);
    expect(isWorkspaceNotes('planning for fb-checkout')).toBe(false);
    expect(isWorkspaceNotes('Feedback workspace · relative.html #1')).toBe(false);
  });
});

describe('the item card and rail', () => {
  it('reads the latest saved workspace and sums it up', () => {
    expect(latestWorkspace(item())).toEqual({ date: '2026-10-18', board: 'fb-checkout-6', png: 'checkout.html.feedback/6-workspace.png' });
    expect(workspaceSummary(item())).toBe('Workspace · saved Oct 18');
    expect(workspaceSummary({ events: [] })).toBeUndefined();
    expect(shortDate('2026-01-05')).toBe('Jan 5');
    expect(shortDate('soon')).toBe('soon');
  });

  it('lists notes, voice notes and pins in file order', () => {
    expect(railEntries(item())).toEqual([
      { kind: 'note', date: '2026-10-13', text: 'check mobile too' },
      { kind: 'note', date: '', text: 'a loose note' },
      { kind: 'voice', date: '2026-10-14', text: 'the chips wrap badly' },
      { kind: 'pin', date: '2026-10-16', text: 'pin 2 · "reads better"' },
      { kind: 'pin', date: '2026-10-17', text: 'sticky “Option B” · make it bigger' },
    ]);
  });

  it('leads with the newest round and its quote', () => {
    expect(workspaceRound(item())).toBe(2);
    expect(workspaceQuote(item(), 2)?.speaker).toBe('Maya');
    expect(workspaceQuote(item(), 1)?.speaker).toBe('Ana');
    expect(workspaceRound({ rounds: [], round: undefined })).toBe(1);
  });
});

describe('seeding', () => {
  const shot = { data: 'data:image/jpeg;base64,AAAA', width: 2000, height: 400 };
  const roundOnly = parseFeedback('- [ ] #1 Pricing is thin\n    Round: 1\n').items[0]!;

  it('starts an empty board with a frame and quote sticky for every round the item came up in', () => {
    const req = seedRequest(item(), empty)!;
    expect(req.elements.map((e) => [e.type, e.id])).toEqual([
      ['frame', 'frame-1'],
      ['sticky', 'quote-1'],
      ['frame', 'frame-2'],
      ['sticky', 'quote-2'],
    ]);
    expect(req.elements[0]).toMatchObject({ label: 'Round 1', x: 0, y: 0 });
    expect(req.elements[1]).toMatchObject({ frameId: 'frame-1', label: '"Where do I filter?" — Ana\n\nChange: Move the filter row above the results.' });
    expect(req.elements[2]).toMatchObject({ label: 'Round 2', x: 1260, y: 0 });
    expect(req.elements[3]).toMatchObject({ frameId: 'frame-2', align: 'left', label: '"I couldn\'t find the filters" — Maya\n\nChange: Move the filter row above the results.' });
  });

  it('puts the element snapshot in the newest round\'s frame, fitted', () => {
    const req = seedRequest(item(), empty, shot)!;
    const image = req.elements.find((e) => e.type === 'image')!;
    expect(image).toMatchObject({ frameId: 'frame-2', image: shot.data });
    expect(image.width! / image.height!).toBeCloseTo(5, 1);
    expect(image.width).toBeLessThan(1100);
    expect(fitSnapshot({ width: 200, height: 100 })).toEqual({ width: 200, height: 100 });
  });

  it('adds only what is missing, to the right, and leaves the rest alone', () => {
    const both = { elements: [{ id: 'f1', type: 'frame' as const, label: 'Round 1', x: 0, y: 0 }, { id: 'f2', type: 'frame' as const, label: 'Round 2', x: 1260, y: 0 }], bounds: { x: 0, y: 0, width: 2360, height: 720 } };
    expect(seedRequest(item(), both)).toBeUndefined();
    const roundOne = { elements: [{ id: 'f1', type: 'frame' as const, label: 'Round 1', x: 0, y: 0 }, { id: 'r', type: 'rectangle' as const, x: 0, y: 0 }], bounds: { x: -20, y: 10, width: 1300, height: 720 } };
    const req = seedRequest(item(), roundOne)!;
    expect(req.elements.map((e) => e.label?.split('\n')[0])).toEqual(['Round 2', '"I couldn\'t find the filters" — Maya']);
    expect(req.elements[0]).toMatchObject({ type: 'frame', x: 1440, y: 10 });
  });

  it('gives a frame made without a picture the snapshot, once', () => {
    const framed = { elements: [{ id: 'f1', type: 'frame' as const, label: 'Round 1', x: 40, y: 50 }, { id: 's', type: 'sticky' as const, frameId: 'f1', x: 88, y: 98 }], bounds: { x: 40, y: 50, width: 1100, height: 720 } };
    const req = seedRequest(roundOnly, framed, shot)!;
    expect(req.elements).toEqual([expect.objectContaining({ type: 'image', frameId: 'f1', x: 40 + 48 * 2 + 320, y: 98 })]);
    const pictured = { ...framed, elements: [...framed.elements, { id: 'i', type: 'image' as const, frameId: 'f1', x: 0, y: 0 }] };
    expect(seedRequest(roundOnly, pictured, shot)).toBeUndefined();
  });

  it('falls back to the title when the item has no quote', () => {
    expect(seedRequest(roundOnly, empty)!.elements[1]!.label).toBe('Pricing is thin');
  });
});
