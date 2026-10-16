import { describe, expect, it } from 'vitest';
import type { OutputRecord } from '../protocol';
import { cleanOutput, isUrlRef, outputLabel, outputTouchedAt, parseOutputsFile, reviewStart, sortOutputs } from './outputs';

const rec = (over: Partial<OutputRecord>): OutputRecord => ({ ref: 'docs/a.md', kind: 'markdown', tier: 'detected', ...over });

describe('cleanOutput', () => {
  it('keeps every well-formed field and trims the title', () => {
    const full = {
      ref: 'docs/plan.md',
      kind: 'markdown',
      tier: 'declared',
      title: '  Launch plan ',
      status: 'ready',
      origin: 'created',
      declaredAt: 5,
      firstWriteAt: 6,
      lastWriteAt: 7,
      writes: 3,
    };
    expect(cleanOutput(full)).toEqual({ ...full, title: 'Launch plan' });
  });

  it('keeps the url of a link record', () => {
    expect(cleanOutput({ ref: 'https://x.dev/a', url: 'https://x.dev/a', kind: 'artifact', tier: 'declared' })).toEqual({
      ref: 'https://x.dev/a',
      url: 'https://x.dev/a',
      kind: 'artifact',
      tier: 'declared',
    });
  });

  it('drops a record with no ref, or an unknown kind or tier', () => {
    for (const raw of [
      null,
      'docs/a.md',
      [],
      { kind: 'markdown', tier: 'detected' },
      { ref: '  ', kind: 'markdown', tier: 'detected' },
      { ref: 'a.md', kind: 'video', tier: 'detected' },
      { ref: 'a.md', tier: 'detected' },
      { ref: 'a.md', kind: 'markdown', tier: 'guessed' },
      { ref: 7, kind: 'markdown', tier: 'detected' },
    ]) {
      expect(cleanOutput(raw), JSON.stringify(raw)).toBeUndefined();
    }
  });

  it('drops malformed optional fields and unknown ones', () => {
    const r = cleanOutput({
      ref: 'a.md',
      kind: 'markdown',
      tier: 'detected',
      status: 'done',
      origin: 'copied',
      title: '',
      url: 3,
      declaredAt: 'now',
      lastWriteAt: Number.NaN,
      writes: Infinity,
      extra: true,
    });
    expect(r).toEqual({ ref: 'a.md', kind: 'markdown', tier: 'detected' });
  });
});

describe('parseOutputsFile', () => {
  it('reads a version 1 file', () => {
    const text = JSON.stringify({ version: 1, sessionId: 's1', outputs: [rec({ lastWriteAt: 4 })] });
    expect(parseOutputsFile(text)).toEqual({ version: 1, sessionId: 's1', outputs: [rec({ lastWriteAt: 4 })] });
  });

  it('skips bad records and keeps the first record for a repeated ref', () => {
    const text = JSON.stringify({
      version: 1,
      sessionId: 's1',
      outputs: [rec({ title: 'first' }), { ref: 'x' }, rec({ title: 'second' }), rec({ ref: 'b.md' })],
    });
    expect(parseOutputsFile(text)?.outputs.map((r) => [r.ref, r.title])).toEqual([
      ['docs/a.md', 'first'],
      ['b.md', undefined],
    ]);
  });

  it('gives undefined for bad JSON, another version or no outputs list', () => {
    for (const text of ['', '{', 'null', '[]', '{"version":2,"outputs":[]}', '{"version":1}', '{"version":1,"outputs":{}}']) {
      expect(parseOutputsFile(text), text).toBeUndefined();
    }
  });

  it('gives an empty session id when the file names none', () => {
    expect(parseOutputsFile('{"version":1,"outputs":[]}')).toEqual({ version: 1, sessionId: '', outputs: [] });
  });
});

describe('outputTouchedAt', () => {
  it('is the later of the declaration and the latest write', () => {
    expect(outputTouchedAt(rec({ declaredAt: 10, lastWriteAt: 4 }))).toBe(10);
    expect(outputTouchedAt(rec({ declaredAt: 10, lastWriteAt: 40 }))).toBe(40);
    expect(outputTouchedAt(rec({ lastWriteAt: 4 }))).toBe(4);
    expect(outputTouchedAt(rec({}))).toBe(0);
  });
});

describe('sortOutputs', () => {
  it('puts declared records first, each tier newest on top, then by ref', () => {
    const records = [
      rec({ ref: 'old-detected.md', lastWriteAt: 1 }),
      rec({ ref: 'old-declared.md', tier: 'declared', declaredAt: 2 }),
      rec({ ref: 'new-detected.md', lastWriteAt: 30 }),
      rec({ ref: 'new-declared.md', tier: 'declared', declaredAt: 3, lastWriteAt: 20 }),
      rec({ ref: 'b.md', lastWriteAt: 1 }),
    ];
    expect(sortOutputs(records).map((r) => r.ref)).toEqual([
      'new-declared.md',
      'old-declared.md',
      'new-detected.md',
      'b.md',
      'old-detected.md',
    ]);
  });

  it('leaves its input alone', () => {
    const records = [rec({ ref: 'a.md' }), rec({ ref: 'b.md', tier: 'declared' })];
    sortOutputs(records);
    expect(records.map((r) => r.ref)).toEqual(['a.md', 'b.md']);
  });
});

describe('outputLabel', () => {
  it('uses the title, then the url, then the file name', () => {
    expect(outputLabel(rec({ title: 'Plan', url: 'https://x.dev' }))).toBe('Plan');
    expect(outputLabel(rec({ ref: 'https://x.dev/a', url: 'https://x.dev/a', kind: 'artifact' }))).toBe('https://x.dev/a');
    expect(outputLabel(rec({ ref: 'docs/deep/plan.md' }))).toBe('plan.md');
    expect(outputLabel(rec({ ref: 'plan.md' }))).toBe('plan.md');
  });
});

describe('isUrlRef', () => {
  it('matches http and https links only', () => {
    expect(isUrlRef('https://claude.ai/artifact/1')).toBe(true);
    expect(isUrlRef('HTTP://x.dev')).toBe(true);
    for (const ref of ['docs/a.md', 'file:///etc/hosts', 'javascript:alert(1)', 'ftp://x.dev', 'https:x']) {
      expect(isUrlRef(ref), ref).toBe(false);
    }
  });
});

describe('reviewStart', () => {
  const page = (ref: string, at: number, over: Partial<OutputRecord> = {}) =>
    rec({ ref, kind: 'html', tier: 'declared', status: 'ready', declaredAt: at, ...over });

  it('opens the newest review that holds something', () => {
    const reviews = [
      { id: 'old', updatedAt: 1, hasContent: true },
      { id: 'blank', updatedAt: 9, hasContent: false },
      { id: 'new', updatedAt: 5, hasContent: true },
    ];
    expect(reviewStart({ reviews, outputs: [page('a.html', 10)], itemWaits: false })).toEqual({ draftId: 'new' });
  });

  it('opens the newest Ready page when no review holds anything', () => {
    const outputs = [
      page('old.html', 1),
      page('new.html', 5),
      page('draft.html', 9, { status: 'drafting' }),
      page('touched.html', 9, { tier: 'detected' }),
      rec({ ref: 'plan.md', kind: 'markdown', tier: 'declared', status: 'ready', declaredAt: 9 }),
    ];
    expect(reviewStart({ reviews: [], outputs, itemWaits: false })).toEqual({ ref: 'new.html' });
  });

  it('opens nothing while an item waits on you, or when there is nothing to review', () => {
    const reviews = [{ id: 'r', updatedAt: 1, hasContent: true }];
    expect(reviewStart({ reviews, outputs: [page('a.html', 1)], itemWaits: true })).toBeUndefined();
    expect(reviewStart({ reviews: [], outputs: [], itemWaits: false })).toBeUndefined();
  });
});
