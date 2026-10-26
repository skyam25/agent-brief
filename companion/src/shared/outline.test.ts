import { describe, expect, it } from 'vitest';
import type { OutlineDoc } from '../protocol';
import { OutlineOpError, applyOutlineOps, cleanOutlineOps, isOutlinePath, outlinePathFor, outlineSlugPath, outlineSummary, parseOutline, serializeOutline } from './outline';

const SAMPLE = `# Onboarding memo

Target: docs/memo.md
Kind: document

## Intent
Reader: VP of Customer Success and the CRO
Goal: decide how new accounts are onboarded
Message: self-serve is faster, but churn needs an answer first
Guide: neutral decision memo; qualify every pilot number

## Direction · 2026-10-25 · proposed
Scope: regenerate
From: 3 comments on docs/memo.md
- The memo asks leadership to choose among three options
- Churn weighs as much as speed
Change: replaced · Intent goal
Change: removed · section Recommendation

## Why change onboarding now ^s1
- New accounts wait a median 6 business days for the kickoff call. ^p1
    Cite: S1 · wait times · supports
    Guide: state it as today's baseline
- Self-serve cut time to first value from 9 to 4 days. ^p2
    Cite: S2 · p.3 · partly · pilot of 12 accounts only
    Keep: 9 to 4 days
- Open: Can support absorb async Q&A without a hire? ^p3
    Default: assume no new hire and flag it as a risk

## Sources
- S1 · CS ops dashboard export, Oct 2026
    Ref: data/cs-ops.csv
    Supports: median wait time
    Not shown: why accounts wait
    Checked: 2026-10-25
- S2 · Self-serve pilot readout
    Ref: docs/pilot.md
`;

const DATE = '2026-10-26';
const apply = (ops: unknown) => applyOutlineOps(SAMPLE, { ops, date: DATE });
const create = (ops: unknown) => applyOutlineOps(undefined, { ops, date: DATE });
const doc = (ops: unknown) => apply(ops).doc;
const error = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(OutlineOpError);
    return (e as Error).message;
  }
  throw new Error('expected an OutlineOpError');
};

describe('outline paths', () => {
  it('recognizes outline files', () => {
    expect(isOutlinePath('docs/memo.outline.md')).toBe(true);
    expect(isOutlinePath('docs/.outline.md')).toBe(false);
    expect(isOutlinePath('docs/memo.md')).toBe(false);
  });

  it('puts the outline beside its target, replacing the last extension', () => {
    expect(outlinePathFor('docs/memo.md')).toBe('docs/memo.outline.md');
    expect(outlinePathFor('site/checkout.html')).toBe('site/checkout.outline.md');
    expect(outlinePathFor('a.b/notes')).toBe('a.b/notes.outline.md');
    expect(outlinePathFor('report.v2.md')).toBe('report.v2.outline.md');
  });

  it('slugs a title', () => {
    expect(outlineSlugPath('Onboarding memo')).toBe('onboarding-memo.outline.md');
    expect(outlineSlugPath('  Café: Q3 plan!  ')).toBe('cafe-q3-plan.outline.md');
    expect(outlineSlugPath('???')).toBe('outline.outline.md');
  });
});

describe('parseOutline', () => {
  it('reads every block of the canonical form', () => {
    const d = parseOutline(SAMPLE);
    expect(d).toMatchObject({ title: 'Onboarding memo', target: 'docs/memo.md', kind: 'document' });
    expect(d.intent[3]).toEqual({ key: 'Guide', text: 'neutral decision memo; qualify every pilot number' });
    expect(d.direction).toEqual({
      date: '2026-10-25',
      state: 'proposed',
      scope: 'regenerate',
      from: '3 comments on docs/memo.md',
      bullets: ['The memo asks leadership to choose among three options', 'Churn weighs as much as speed'],
      changes: ['replaced · Intent goal', 'removed · section Recommendation'],
    });
    const [p1, p2, p3] = d.sections[0]!.points;
    expect(p1).toEqual({ id: 'p1', kind: 'point', text: 'New accounts wait a median 6 business days for the kickoff call.', cites: [{ source: 'S1', location: 'wait times', mark: 'supports' }], guide: "state it as today's baseline" });
    expect(p2!.cites).toEqual([{ source: 'S2', location: 'p.3', mark: 'partly', note: 'pilot of 12 accounts only' }]);
    expect(p2!.keep).toBe('9 to 4 days');
    expect(p3).toMatchObject({ kind: 'open', text: 'Can support absorb async Q&A without a hire?', default: 'assume no new hire and flag it as a risk' });
    expect(d.sources[0]).toEqual({ id: 'S1', title: 'CS ops dashboard export, Oct 2026', ref: 'data/cs-ops.csv', supports: 'median wait time', notShown: 'why accounts wait', checked: '2026-10-25' });
    expect(d.extra).toBeUndefined();
  });

  it('round trips the canonical text', () => {
    expect(serializeOutline(parseOutline(SAMPLE))).toBe(SAMPLE);
  });

  it('round trips a doc', () => {
    const d: OutlineDoc = {
      title: 'Checkout',
      kind: 'page',
      intent: [],
      sections: [{ id: 's2', title: 'Header', points: [{ id: 'p4', kind: 'point', text: 'Logo left', cites: [{ source: 'B', location: 'board:checkout · frame 2' }], extra: ['    Later: maybe'] }], extra: ['Some prose'] }],
      sources: [{ id: 'B', title: 'Board', ref: 'board:checkout' }],
      extra: ['A stray line'],
    };
    expect(parseOutline(serializeOutline(d))).toEqual(d);
  });

  it('numbers missing and repeated ids after the highest', () => {
    const d = parseOutline(`# T\n\n## First\n- a\n- b ^p4\n\n## Second ^s3\n- c ^p4\n- d\n\n## Sources\n- A source\n- S5 · Another`);
    expect(d.sections.map((s) => s.id)).toEqual(['s4', 's3']);
    expect(d.sections.flatMap((s) => s.points.map((p) => p.id))).toEqual(['p5', 'p4', 'p6', 'p7']);
    expect(d.sources).toEqual([{ id: 'S6', title: 'A source' }, { id: 'S5', title: 'Another' }]);
    expect(d.kind).toBe('document');
  });

  it('splits cites with and without marks', () => {
    const cites = parseOutline('# T\n\n## A ^s1\n- x ^p1\n    Cite: S1\n    Cite: S1 · p.3\n    Cite: S1 · ch. 2 · p.3\n    Cite: S1 · not\n    Cite: S1 · p.3 · unknown · paywalled · retry').sections[0]!.points[0]!.cites;
    expect(cites).toEqual([
      { source: 'S1' },
      { source: 'S1', location: 'p.3' },
      { source: 'S1', location: 'ch. 2 · p.3' },
      { source: 'S1', mark: 'not' },
      { source: 'S1', location: 'p.3', mark: 'unknown', note: 'paywalled · retry' },
    ]);
  });

  it('keeps unknown lines where they sit and drops blank ones', () => {
    const text = 'Preamble\n# T\nKind: poster\n\n## Intent\nno key here\n\n## A ^s1\nProse under A\n\n- x ^p1\n    Guide: one\n    Guide: two\n    Note: free\n\n## Sources\n- S1 · Src\n    Pages: 4\nloose';
    const d = parseOutline(text);
    expect(d.kind).toBe('document');
    expect(d.extra).toEqual(['Preamble', 'Kind: poster', 'no key here', 'loose']);
    expect(d.sections[0]!.extra).toEqual(['Prose under A']);
    expect(d.sections[0]!.points[0]).toMatchObject({ guide: 'one', extra: ['    Guide: two', '    Note: free'] });
    expect(d.sources[0]!.extra).toEqual(['    Pages: 4']);
    expect(parseOutline(serializeOutline(d))).toEqual(d);
  });

  it('reads a heading with an id as a section, whatever its title', () => {
    const d = parseOutline('# T\n\n## Sources ^s1\n- x ^p1\n\n## Intent ^s2');
    expect(d.sections.map((s) => s.title)).toEqual(['Sources', 'Intent']);
    expect(d.sources).toEqual([]);
  });

  it('reads CRLF endings', () => {
    expect(parseOutline(SAMPLE.replace(/\n/g, '\r\n'))).toEqual(parseOutline(SAMPLE));
  });
});

describe('cleanOutlineOps', () => {
  it('accepts a list or { ops }, and trims', () => {
    const ops = [{ op: 'addSection', title: '  Risks ' }];
    expect(cleanOutlineOps(ops)).toEqual([{ op: 'addSection', title: 'Risks' }]);
    expect(cleanOutlineOps({ ops })).toEqual([{ op: 'addSection', title: 'Risks' }]);
  });

  it('names the op index', () => {
    expect(error(() => cleanOutlineOps([{ op: 'clearDirection' }, { op: 'addPoint', section: 's1' }]))).toBe('ops[1]: Point text is empty');
    expect(error(() => cleanOutlineOps([{ op: 'nope' }]))).toBe('ops[0]: Unknown op nope');
  });

  it('rejects bad shapes', () => {
    expect(error(() => cleanOutlineOps([]))).toBe('Expected ops');
    expect(error(() => cleanOutlineOps('x'))).toBe('Expected ops');
    expect(error(() => cleanOutlineOps([null]))).toMatch(/Each op is an object/);
    expect(error(() => cleanOutlineOps([{ op: 'setMeta' }]))).toMatch(/setMeta sets/);
    expect(error(() => cleanOutlineOps([{ op: 'setMeta', target: '../x.md' }]))).toMatch(/inside the project/);
    expect(error(() => cleanOutlineOps([{ op: 'setMeta', kind: 'poster' }]))).toMatch(/Kind is document \| page/);
    expect(error(() => cleanOutlineOps([{ op: 'addSection', title: 'a\nb' }]))).toMatch(/one line/);
    expect(error(() => cleanOutlineOps([{ op: 'addPoint', section: 's1', text: 'Open: x' }]))).toMatch(/kind open/);
    expect(error(() => cleanOutlineOps([{ op: 'addPoint', section: 's1', text: 'x', cites: [{ source: 'S1', note: 'n' }] }]))).toMatch(/needs a mark/);
    expect(error(() => cleanOutlineOps([{ op: 'addPoint', section: 's1', text: 'x', cites: [{ source: 'S1', mark: 'maybe' }] }]))).toMatch(/Cite mark/);
    expect(error(() => cleanOutlineOps([{ op: 'addPoint', section: 's1', text: 'x', cites: [{ source: 'S1', location: 'p · not · q' }] }]))).toMatch(/mark word/);
    expect(error(() => cleanOutlineOps([{ op: 'setIntent', lines: [{ key: 'A:B', text: 'x' }] }]))).toMatch(/Intent key/);
    expect(error(() => cleanOutlineOps([{ op: 'addSource', title: 'x', id: '1 2' }]))).toMatch(/Source id/);
    expect(error(() => cleanOutlineOps([{ op: 'editSource', id: 'S1', checked: 'today' }]))).toMatch(/YYYY-MM-DD/);
    expect(error(() => cleanOutlineOps([{ op: 'setDirection', direction: { scope: 'all' } }]))).toMatch(/Direction scope/);
    expect(error(() => cleanOutlineOps(Array.from({ length: 201 }, () => ({ op: 'clearDirection' }))))).toMatch(/At most 200/);
  });
});

describe('applyOutlineOps', () => {
  it('creates a new outline from setMeta and returns canonical text', () => {
    const r = create([
      { op: 'setMeta', title: 'Checkout', kind: 'page' },
      { op: 'addSection', title: 'Header' },
      { op: 'addPoint', section: 's1', text: 'Logo on the left' },
      { op: 'addSource', title: 'Checkout board', ref: 'board:checkout' },
    ]);
    expect(r.text).toBe('# Checkout\n\nKind: page\n\n## Header ^s1\n- Logo on the left ^p1\n\n## Sources\n- S1 · Checkout board\n    Ref: board:checkout\n');
    expect(r.added).toEqual(['s1', 'p1', 'S1']);
    expect(r.doc).toEqual(parseOutline(r.text));
  });

  it('needs a title for a new outline', () => {
    expect(error(() => create([{ op: 'addSection', title: 'A' }]))).toMatch(/needs a setMeta op with a title/);
  });

  it('sets and clears meta', () => {
    const d = doc([{ op: 'setMeta', title: 'Memo', target: null, kind: 'page' }]);
    expect(d).toMatchObject({ title: 'Memo', kind: 'page' });
    expect(d.target).toBeUndefined();
    expect(doc([{ op: 'setMeta', target: 'docs/memo-v2.md' }]).target).toBe('docs/memo-v2.md');
  });

  it('replaces the intent, and omits an empty one', () => {
    expect(doc([{ op: 'setIntent', lines: [{ key: 'Reader', text: 'the CRO' }] }]).intent).toEqual([{ key: 'Reader', text: 'the CRO' }]);
    expect(apply([{ op: 'setIntent', lines: [] }]).text).not.toContain('## Intent');
  });

  it('adds, edits, moves and removes sections', () => {
    expect(doc([{ op: 'addSection', title: 'Risks', after: null }]).sections.map((s) => s.id)).toEqual(['s2', 's1']);
    expect(doc([{ op: 'addSection', title: 'Risks' }, { op: 'addSection', title: 'Ask', after: 's1' }]).sections.map((s) => s.title)).toEqual(['Why change onboarding now', 'Ask', 'Risks']);
    expect(doc([{ op: 'editSection', id: 's1', title: 'Why now' }]).sections[0]!.title).toBe('Why now');
    expect(doc([{ op: 'addSection', title: 'B' }, { op: 'moveSection', id: 's2', after: null }]).sections.map((s) => s.id)).toEqual(['s2', 's1']);
    expect(doc([{ op: 'addSection', title: 'B' }, { op: 'moveSection', id: 's1', after: 's2' }]).sections.map((s) => s.id)).toEqual(['s2', 's1']);
    const r = apply([{ op: 'removeSection', id: 's1' }]);
    expect(r.doc.sections).toEqual([]);
    expect(r.text).not.toContain('^p1');
  });

  it('adds points in place, with their fields', () => {
    const r = apply([
      { op: 'addPoint', section: 's1', text: 'Churn rose in the pilot', after: 'p1', cites: [{ source: 'S2', location: 'p.5' }], guide: 'say it plainly', keep: '3 of 12' },
      { op: 'addPoint', section: 's1', text: 'Who owns kickoff?', kind: 'open', after: null, default: 'CS owns it' },
    ]);
    expect(r.added).toEqual(['p4', 'p5']);
    expect(r.doc.sections[0]!.points.map((p) => p.id)).toEqual(['p5', 'p1', 'p4', 'p2', 'p3']);
    expect(r.text).toContain('- Churn rose in the pilot ^p4\n    Cite: S2 · p.5\n    Guide: say it plainly\n    Keep: 3 of 12\n');
    expect(r.text).toContain('- Open: Who owns kickoff? ^p5\n    Default: CS owns it\n');
  });

  it('edits points, replacing given fields and clearing nulls', () => {
    const p = doc([{ op: 'editPoint', id: 'p2', text: 'Self-serve halved time to value.', kind: 'open', cites: [{ source: 'S2', location: 'p.3', mark: 'supports' }], keep: null, guide: 'cautious' }]).sections[0]!.points[1]!;
    expect(p).toEqual({ id: 'p2', kind: 'open', text: 'Self-serve halved time to value.', cites: [{ source: 'S2', location: 'p.3', mark: 'supports' }], guide: 'cautious' });
    expect(doc([{ op: 'editPoint', id: 'p1', cites: [] }]).sections[0]!.points[0]!.cites).toEqual([]);
  });

  it('moves points within and across sections', () => {
    expect(doc([{ op: 'movePoint', id: 'p3', section: 's1', after: null }]).sections[0]!.points.map((p) => p.id)).toEqual(['p3', 'p1', 'p2']);
    const d = doc([{ op: 'addSection', title: 'Risks' }, { op: 'movePoint', id: 'p1', section: 's2', after: null }, { op: 'movePoint', id: 'p3', section: 's2', after: 'p1' }]);
    expect(d.sections.map((s) => s.points.map((p) => p.id))).toEqual([['p2'], ['p1', 'p3']]);
  });

  it('removes points', () => {
    expect(doc([{ op: 'removePoint', id: 'p2' }]).sections[0]!.points.map((p) => p.id)).toEqual(['p1', 'p3']);
  });

  it('adds, edits and removes sources', () => {
    const r = apply([
      { op: 'addSource', title: 'Churn report', ref: 'data/churn.csv', supports: 'churn by cohort', notShown: 'why' },
      { op: 'addSource', title: 'Board', id: 'B1' },
    ]);
    expect(r.added).toEqual(['S3', 'B1']);
    expect(r.doc.sources[2]).toEqual({ id: 'S3', title: 'Churn report', ref: 'data/churn.csv', supports: 'churn by cohort', notShown: 'why' });
    const s1 = doc([{ op: 'editSource', id: 'S1', title: 'CS ops export', ref: null, notShown: null, checked: '2026-10-26' }]).sources[0];
    expect(s1).toEqual({ id: 'S1', title: 'CS ops export', supports: 'median wait time', checked: '2026-10-26' });
  });

  it('drops the cites that name a removed source', () => {
    const d = doc([{ op: 'editPoint', id: 'p1', cites: [{ source: 'S1' }, { source: 'S2', mark: 'not' }] }, { op: 'removeSource', id: 'S1' }]);
    expect(d.sources.map((s) => s.id)).toEqual(['S2']);
    expect(d.sections[0]!.points[0]!.cites).toEqual([{ source: 'S2', mark: 'not' }]);
  });

  it('sets the direction, dated today by default, and clears it', () => {
    const r = apply([{ op: 'setDirection', direction: { state: 'accepted', scope: 'sections', bullets: ['Lead with churn'], changes: ['added · point p4'] } }]);
    expect(r.doc.direction).toEqual({ date: DATE, state: 'accepted', scope: 'sections', bullets: ['Lead with churn'], changes: ['added · point p4'] });
    expect(r.text).toContain(`## Direction · ${DATE} · accepted\nScope: sections\n- Lead with churn\nChange: added · point p4\n`);
    expect(doc([{ op: 'setDirection', direction: { date: '2026-10-20', scope: 'edit' } }]).direction).toMatchObject({ date: '2026-10-20', state: 'proposed', bullets: [], changes: [] });
    const cleared = apply([{ op: 'clearDirection' }]);
    expect(cleared.doc.direction).toBeUndefined();
    expect(cleared.text).not.toContain('## Direction');
  });

  it('throws on unknown ids, naming the op', () => {
    expect(error(() => apply([{ op: 'editSection', id: 's9', title: 'x' }]))).toBe('ops[0] editSection: There is no section s9');
    expect(error(() => apply([{ op: 'clearDirection' }, { op: 'removePoint', id: 'p9' }]))).toBe('ops[1] removePoint: There is no point p9');
    expect(error(() => apply([{ op: 'addPoint', section: 's1', text: 'x', after: 'p9' }]))).toMatch(/There is no point in s1 p9/);
    expect(error(() => apply([{ op: 'movePoint', id: 'p1', section: 's1', after: 'p9' }]))).toMatch(/There is no point in s1 p9/);
    expect(error(() => apply([{ op: 'movePoint', id: 'p1', section: 's7', after: null }]))).toMatch(/There is no section s7/);
    expect(error(() => apply([{ op: 'addSection', title: 'x', after: 's9' }]))).toMatch(/There is no section s9/);
    expect(error(() => apply([{ op: 'removeSource', id: 'S9' }]))).toMatch(/There is no source S9/);
    expect(error(() => apply([{ op: 'addPoint', section: 's1', text: 'x', cites: [{ source: 'S9' }] }]))).toMatch(/no source S9. Add it/);
    expect(error(() => apply([{ op: 'addSource', title: 'x', id: 'S1' }]))).toMatch(/S1 already exists/);
    expect(error(() => apply([{ op: 'moveSection', id: 's1', after: 's1' }]))).toMatch(/after itself/);
  });

  it('lets later ops in a batch name new ids by label', () => {
    const r = apply([
      { op: 'addSource', title: 'Interview notes', label: 'notes' },
      { op: 'addSection', title: 'Risks', label: 'risks' },
      { op: 'addPoint', section: '@risks', text: 'Training could offset the gain.', cites: [{ source: '@notes' }], label: 'train' },
      { op: 'addPoint', section: '@risks', text: 'Support load is unknown.', after: '@train' },
    ]);
    const risks = r.doc.sections.find((s) => s.title === 'Risks')!;
    expect(risks.points.map((p) => p.text)).toEqual(['Training could offset the gain.', 'Support load is unknown.']);
    expect(risks.points[0].cites[0].source).toBe(r.added[0]);
    expect(r.text).not.toContain('@');
    expect(error(() => apply([{ op: 'addPoint', section: '@nope', text: 'x' }]))).toMatch(/No earlier op in this batch has label nope/);
    expect(error(() => apply([{ op: 'addSection', title: 'a', label: 'x' }, { op: 'addSection', title: 'b', label: 'x' }]))).toMatch(/Label x is already used/);
  });
});

describe('outlineSummary', () => {
  it('counts sections, points and cites', () => {
    expect(outlineSummary('docs/memo.outline.md', parseOutline(SAMPLE))).toEqual({
      path: 'docs/memo.outline.md',
      title: 'Onboarding memo',
      target: 'docs/memo.md',
      kind: 'document',
      sections: 1,
      points: 3,
      open: 1,
      cites: 2,
      unchecked: 0,
      flagged: 1,
      direction: 'proposed',
    });
  });
});
