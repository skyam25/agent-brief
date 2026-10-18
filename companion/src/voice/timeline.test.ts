import { describe, expect, it } from 'vitest';
import { buildTimeline, clock, imageWords, meaningful, positionWords, sizeWords, trimSpeech } from './timeline';
import type { StrokeEvent, Utterance } from './types';

const bounds = { x: 0, y: 0, width: 900, height: 900 };
const box = (x: number, y: number, w = 50, h = 50) => ({ x, y, width: w, height: h });

let n = 0;
function stroke(t: number, over: Partial<StrokeEvent> = {}): StrokeEvent {
  n += 1;
  return {
    t,
    tEnd: t + 200,
    elementId: `e${n}`,
    type: 'freedraw',
    bbox: box(10, 10),
    by: 'user',
    kind: 'add',
    ...over,
  };
}

const say = (t: number, tEnd: number, text: string, over: Partial<Utterance> = {}): Utterance => ({
  t,
  tEnd,
  text,
  audio: 'audio/seg-0.webm',
  audioStart: 0,
  ...over,
});

const build = (strokes: StrokeEvent[], utterances: Utterance[] = []) =>
  buildTimeline({ strokes, utterances, bounds, boardName: 'main' });

describe('numbering', () => {
  it('numbers user additions in time order, ignoring input order, Claude and edits', () => {
    const a = stroke(5000, { elementId: 'a' });
    const b = stroke(1000, { elementId: 'b' });
    const c = stroke(3000, { elementId: 'c', by: 'claude' });
    const d = stroke(4000, { elementId: 'd', kind: 'move' });
    const e = stroke(2000, { elementId: 'e' });
    expect(build([a, b, c, d, e]).strokeNumbers).toEqual({ b: 1, e: 2, a: 3 });
  });

  it('keeps input order for equal times', () => {
    const x = stroke(0, { elementId: 'x', bbox: box(0, 0) });
    const y = stroke(0, { elementId: 'y', bbox: box(800, 800) });
    expect(build([x, y]).strokeNumbers).toEqual({ x: 1, y: 2 });
  });
});

describe('position and size words', () => {
  it('names the nine cells', () => {
    const at = (cx: number, cy: number) => positionWords(box(cx - 5, cy - 5, 10, 10), bounds);
    expect(at(100, 100)).toBe('top left');
    expect(at(450, 100)).toBe('top');
    expect(at(800, 100)).toBe('top right');
    expect(at(100, 450)).toBe('left');
    expect(at(450, 450)).toBe('centre');
    expect(at(800, 450)).toBe('right');
    expect(at(100, 800)).toBe('bottom left');
    expect(at(450, 800)).toBe('bottom');
    expect(at(800, 800)).toBe('bottom right');
  });

  it('centres on empty bounds', () => {
    expect(positionWords(box(5, 5), { x: 0, y: 0, width: 0, height: 0 })).toBe('centre');
  });

  it('sizes by the longer edge against the bounds', () => {
    expect(sizeWords(box(0, 0, 50, 50), bounds)).toBe('small');
    expect(sizeWords(box(0, 0, 200, 50), bounds)).toBe('medium');
    expect(sizeWords(box(0, 0, 50, 500), bounds)).toBe('large');
  });
});

describe('grouping', () => {
  it('joins rapid overlapping strokes into a range', () => {
    const s = [
      stroke(0, { bbox: box(10, 10) }),
      stroke(500, { bbox: box(40, 10) }),
      stroke(1000, { bbox: box(80, 10) }),
    ];
    const md = build(s).timelineMd;
    expect(md).toContain('[00:00–00:01] strokes 1–3 · freehand · top left · medium');
    expect(md).not.toContain('stroke 2');
  });

  it('splits on a gap of 600 ms or more', () => {
    const s = [stroke(0), stroke(800)];
    const md = build(s).timelineMd;
    expect(md).toContain('stroke 1 ·');
    expect(md).toContain('stroke 2 ·');
  });

  it('splits when boxes do not overlap', () => {
    const s = [stroke(0, { bbox: box(0, 0) }), stroke(300, { bbox: box(700, 700) })];
    expect(build(s).timelineMd).toContain('stroke 2 ·');
  });

  it('calls a mixed group mixed', () => {
    const s = [stroke(0), stroke(300, { type: 'rectangle' })];
    expect(build(s).timelineMd).toContain('strokes 1–2 · mixed');
  });
});

const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

describe('anchoring', () => {
  it('names the stroke drawn while the utterance is spoken, once', () => {
    const md = build([stroke(3000)], [say(2500, 5000, 'this is the header')]).timelineMd;
    expect(md).toContain(
      '[00:02–00:05] 🎙️ "this is the header" — while drawing stroke 1 (freehand, top left, small)',
    );
    expect(count(md, 'this is the header')).toBe(1);
    expect(md).not.toMatch(/^\[00:03\] stroke 1/m);
    expect(md).not.toMatch(/[+-]\d\.\ds/);
  });

  it('prints one utterance once however many strokes fall inside it', () => {
    const strokes = [
      stroke(0, { bbox: box(10, 10, 800, 100) }),
      stroke(1000, { bbox: box(10, 790, 800, 100) }),
    ];
    const md = build(strokes, [say(0, 2000, 'This pricing table is too dense.')]).timelineMd;
    expect(count(md, 'This pricing table is too dense.')).toBe(1);
    expect(md).toContain(
      '[00:00–00:02] 🎙️ "This pricing table is too dense." — while drawing stroke 1 (freehand, top, large) and stroke 2 (freehand, bottom, large)',
    );
  });

  it('lists three or more strokes with commas and "and"', () => {
    const strokes = [
      stroke(0, { bbox: box(0, 0) }),
      stroke(1000, { bbox: box(400, 400) }),
      stroke(2000, { bbox: box(800, 800) }),
    ];
    const md = build(strokes, [say(0, 3000, 'all three')]).timelineMd;
    expect(md).toMatch(/while drawing stroke 1 \([^)]*\), stroke 2 \([^)]*\) and stroke 3 \([^)]*\)/);
  });

  it('anchors to the last stroke that ended up to 1.5 s before', () => {
    const md = build([stroke(1000)], [say(2600, 4000, 'looks fine')]).timelineMd; // ends 1200, 1.4 s before
    expect(md).toContain('"looks fine" — just after drawing stroke 1 (freehand, top left, small)');
    expect(md).not.toMatch(/^\[00:01\] stroke 1/m);
  });

  it('keeps a stroke on its own line when no speech covers it', () => {
    const md = build([stroke(1000)], [say(2800, 4000, 'later')]).timelineMd; // 1.6 s after end
    expect(md).toContain('[00:01] stroke 1 · freehand · top left · small');
    expect(md).toContain('[00:02–00:04] 🎙️ "later" — nearest: stroke 1, ended 2s before');
    expect(md).not.toContain('drawing stroke');
  });

  it('prefers strokes during the speech over earlier ones', () => {
    const s = [stroke(0, { bbox: box(0, 0) }), stroke(2000, { bbox: box(700, 700) })];
    const md = build(s, [say(1900, 3000, 'right here')]).timelineMd;
    expect(md).toContain('"right here" — while drawing stroke 2 (');
    expect(md).not.toContain('while drawing stroke 1');
    expect(md).toMatch(/^\[00:00\] stroke 1 ·/m);
  });

  it('names a stroke that two utterances span in both lines, but each speech once', () => {
    const md = build([stroke(0, { tEnd: 4000 })], [say(0, 1500, 'one'), say(3200, 3900, 'two')]).timelineMd;
    expect(count(md, '"one"')).toBe(1);
    expect(count(md, '"two"')).toBe(1);
    expect(count(md, 'while drawing stroke 1')).toBe(2);
  });

  it('caps a long utterance at six stroke references', () => {
    const strokes = Array.from({ length: 9 }, (_, i) =>
      stroke(i * 2000, { bbox: box(i * 90, i * 90, 20, 20) }),
    );
    const md = build(strokes, [say(0, 20_000, 'a long ramble')]).timelineMd;
    const line = md.split('\n').find((l) => l.includes('a long ramble'))!;
    expect(count(line, 'stroke ')).toBe(6);
    expect(line).toContain('and 3 more');
  });

  it('does not cap a short utterance', () => {
    const strokes = Array.from({ length: 8 }, (_, i) =>
      stroke(i * 500, { bbox: box(i * 100, i * 100, 20, 20), tEnd: i * 500 + 100 }),
    );
    const md = build(strokes, [say(0, 5000, 'quick')]).timelineMd;
    const line = md.split('\n').find((l) => l.includes('quick'))!;
    expect(line).not.toContain('more');
  });

  it('does not anchor to Claude strokes', () => {
    const md = build([stroke(1000, { by: 'claude', elementId: 'r1', type: 'rectangle' })], [
      say(1000, 2000, 'hmm'),
    ]).timelineMd;
    expect(md).toContain('[00:01–00:02] 🎙️ "hmm"');
    expect(md).not.toContain('drawing');
    expect(md).not.toContain('nearest');
  });
});

describe('markdown', () => {
  it('formats header, chronological lines and audio offsets', () => {
    const strokes = [
      stroke(3000, { elementId: 's1' }),
      stroke(9000, { by: 'claude', elementId: 'r1', type: 'rectangle', label: 'Header', bbox: box(400, 400, 100, 100) }),
      stroke(12_000, { kind: 'erase', elementId: 's1' }),
      stroke(13_000, { kind: 'move', elementId: 'r1', by: 'claude' }),
    ];
    const utterances = [
      say(3400, 4000, 'this is the header'),
      say(20_000, 21_000, 'say "hi"', { audio: 'audio/seg-1.webm', audioStart: 15_000 }),
    ];
    const { timelineMd } = build(strokes, utterances);
    expect(timelineMd).toBe(
      [
        '# Sketch timeline: main',
        '',
        'Duration 00:21 · 0 strokes (1 erased) · 1 Claude element · 2 utterances',
        '',
        '[00:03–00:04] 🎙️ "this is the header" — just after drawing stroke 1 (freehand, top left, small)',
        '[00:09] Claude drew r1 rectangle "Header" · centre',
        '[00:12] erased stroke 1',
        '[00:13] Claude moved r1',
        "[00:20–00:21] 🎙️ \"say 'hi'\"",
        '',
        '## Audio',
        '',
        '- [00:03–00:04] audio/seg-0.webm at 3.4s',
        '- [00:20–00:21] audio/seg-1.webm at 5.0s',
        '',
      ].join('\n'),
    );
  });

  it('skips Audio when silent', () => {
    const md = build([stroke(0)]).timelineMd;
    expect(md).not.toContain('## Audio');
    expect(md).toContain('Duration 00:00');
  });

  it('formats clock times', () => {
    expect(clock(0)).toBe('00:00');
    expect(clock(59_999)).toBe('00:59');
    expect(clock(61_000)).toBe('01:01');
  });
});

describe('cleanup', () => {
  it('drops an erase and the add that restores it within 5 s', () => {
    const a = stroke(0, { elementId: 'a' });
    const churn = [
      stroke(10_000, { elementId: 'a', kind: 'erase' }),
      stroke(11_000, { elementId: 'a' }),
      stroke(12_000, { elementId: 'a', kind: 'erase' }),
      stroke(12_500, { elementId: 'a' }),
    ];
    expect(meaningful([a, ...churn])).toEqual([a]);
    const md = build([a, ...churn]).timelineMd;
    expect(md).not.toContain('erased');
    expect(count(md, 'stroke 1')).toBe(1);
  });

  it('keeps an erase that is not restored, or restored later than 5 s', () => {
    const a = stroke(0, { elementId: 'a' });
    const erase = stroke(1000, { elementId: 'a', kind: 'erase' });
    const late = stroke(7000, { elementId: 'a' });
    expect(meaningful([a, erase, late])).toEqual([a, erase, late]);
  });

  it('drops stray freehand taps and leaves them unnumbered', () => {
    const tap = stroke(0, { elementId: 'tap', bbox: box(100, 100, 0, 0) });
    const line = stroke(2000, { elementId: 'line' });
    const r = build([tap, line, stroke(3000, { elementId: 'tap', kind: 'erase' })]);
    expect(r.strokeNumbers).toEqual({ line: 1 });
    expect(r.timelineMd).not.toContain('erased');
  });
});

describe('images', () => {
  const img = { x: 0, y: 0, width: 600, height: 400 };

  it('lists a pasted image on its own line and leaves it unnumbered', () => {
    const r = build([stroke(0, { elementId: 'shot', type: 'image', bbox: img }), stroke(2000, { elementId: 'mark' })]);
    expect(r.strokeNumbers).toEqual({ mark: 1 });
    expect(r.timelineMd).toContain('[00:00] pasted image A · top · large');
    expect(r.timelineMd).toContain('1 stroke · 1 image ·');
    expect(r.imageLetters).toEqual({ shot: 'A' });
  });

  it('places strokes relative to the image they overlap', () => {
    const placed = [{ box: img }];
    expect(imageWords(box(500, 150, 50, 50), placed)).toBe('on the image, right');
    expect(imageWords(box(560, 150, 100, 100), placed)).toBe("at the image's right edge");
    expect(imageWords(box(580, -60, 100, 100), placed)).toBe("at the image's top right corner");
    expect(imageWords(box(800, 800, 10, 10), placed)).toBeUndefined();
    expect(imageWords(box(500, 150, 50, 50), [{ box: img, letter: 'B' }])).toBe('on image B, right');
    const md = buildTimeline({ strokes: [stroke(0, { bbox: box(500, 150, 50, 50) })], utterances: [], bounds, images: [img] }).timelineMd;
    expect(md).toContain('stroke 1 · freehand · on the image, right · small');
  });
});

describe('speech, images and erases', () => {
  it('joins speech split by short pauses into one line', () => {
    const md = build([], [say(37_000, 38_000, 'The.'), say(38_200, 42_000, 'Left panel here.'), say(44_000, 45_000, 'Wider.')]).timelineMd;
    expect(md).toContain('[00:37–00:42] 🎙️ "The. Left panel here."');
    expect(md).toContain('[00:44–00:45] 🎙️ "Wider."');
    expect(md).toContain('2 utterances');
  });

  it('points speech at the image pasted nearest to it, and letters only images that stay', () => {
    const img = (id: string, t: number, x: number) => stroke(t, { elementId: id, type: 'image', bbox: box(x, 0, 300, 200) });
    const s = [
      img('gone', 0, 0),
      stroke(2000, { elementId: 'gone', kind: 'erase' }),
      img('a', 3000, 0),
      img('b', 33_000, 500),
    ];
    const r = build(s, [say(12_000, 19_000, 'that icon style'), say(38_000, 45_000, 'the left panel')]);
    expect(r.imageLetters).toEqual({ a: 'A', b: 'B' });
    expect(r.timelineMd).toContain('"that icon style" — nearest: image A, pasted 9s before');
    expect(r.timelineMd).toContain('"the left panel" — nearest: image B, pasted 5s before');
    expect(r.timelineMd).toContain('pasted image (erased later)');
    expect(r.timelineMd).toContain('2 images (1 erased)');
  });

  it('puts erases from one moment on one line', () => {
    const s = [
      stroke(0, { elementId: 'shot', type: 'image', bbox: box(0, 0, 300, 200) }),
      stroke(500, { elementId: 'mark' }),
      stroke(2000, { elementId: 'shot', kind: 'erase', type: 'image' }),
      stroke(2050, { elementId: 'mark', kind: 'erase' }),
    ];
    const md = build(s).timelineMd;
    expect(md).toContain('[00:02] erased an image and stroke 1');
    expect(md.match(/^\[[\d:–]+\] erased/gm)).toHaveLength(1);
  });
});

describe('nearest stroke', () => {
  it('names the closest stroke within a minute when none is drawn during the speech', () => {
    const s = [stroke(0, { elementId: 'far', bbox: box(0, 0) }), stroke(6000, { elementId: 'near', bbox: box(700, 700) })];
    const md = build(s, [say(17_000, 20_000, 'collapse this')]).timelineMd;
    expect(md).toContain('"collapse this" — nearest: stroke 2, ended 11s before');
  });

  it('can point at a stroke drawn after the speech, and skips erased ones', () => {
    const s = [
      stroke(0, { elementId: 'gone' }),
      stroke(1000, { elementId: 'gone', kind: 'erase' }),
      stroke(9000, { elementId: 'next', bbox: box(700, 700) }),
    ];
    const md = build(s, [say(3000, 5000, 'then this')]).timelineMd;
    expect(md).toContain('"then this" — nearest: stroke 2, started 4s after');
  });

  it('skips a stroke erased later in the session', () => {
    const s = [
      stroke(0, { elementId: 'kept', bbox: box(0, 0) }),
      stroke(9000, { elementId: 'later-gone', bbox: box(700, 700) }),
      stroke(20_000, { elementId: 'later-gone', kind: 'erase' }),
    ];
    const md = build(s, [say(5000, 6000, 'this one')]).timelineMd;
    expect(md).toContain('"this one" — nearest: stroke 1, ended 5s before');
  });

  it('names nothing past a minute', () => {
    const md = build([stroke(0)], [say(70_000, 71_000, 'much later')]).timelineMd;
    expect(md).not.toContain('nearest');
  });
});

describe('speech and transcript', () => {
  it('joins text in time order', () => {
    const r = build([], [say(5000, 6000, 'second'), say(1000, 2000, 'first')]);
    expect(r.speech).toBe('first second');
    expect(r.transcript.map((u) => u.text)).toEqual(['first', 'second']);
  });

  it('trims long speech with an ellipsis', () => {
    const out = trimSpeech(['word '.repeat(200)]);
    expect(out.length).toBe(400);
    expect(out.endsWith('…')).toBe(true);
  });

  it('leaves short speech alone', () => {
    expect(trimSpeech(['a', ' b '])).toBe('a b');
    expect(build([]).speech).toBe('');
  });
});
