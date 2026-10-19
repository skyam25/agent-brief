import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OutputWatch } from './output-watch';

const watches: OutputWatch[] = [];
afterEach(() => {
  while (watches.length) watches.pop()!.clear();
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'output-watch-'));
  const page = join(root, 'page.html');
  const feedback = `${page}.feedback.md`;
  writeFileSync(page, '<h1>One</h1>');
  const seen: string[] = [];
  const resolved: string[] = [];
  const w = new OutputWatch(
    (sessionId, path) => {
      resolved.push(`${sessionId}:${path}`);
      if (path === 'bad.html') throw new Error('outside the project');
      return { output: join(root, path), feedback: `${join(root, path)}.feedback.md` };
    },
    (sessionId, path, kind) => seen.push(`${sessionId}:${path}:${kind}`),
    { debounceMs: 30, pollMs: 40 },
  );
  watches.push(w);
  return { root, page, feedback, seen, resolved, w };
}

const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));

describe('OutputWatch', () => {
  it('reports an outside write to the output and its feedback file, one per burst', async () => {
    const t = setup();
    t.w.watch('s1', 'page.html');
    await settle(50);
    for (const text of ['<h1>Two</h1>', '<h1>Three</h1>', '<h1>Four!</h1>']) writeFileSync(t.page, text);
    await vi.waitFor(() => expect(t.seen).toEqual(['s1:page.html:output']), { timeout: 2000 });
    writeFileSync(t.feedback, '# Feedback · page.html\n');
    await vi.waitFor(() => expect(t.seen).toEqual(['s1:page.html:output', 's1:page.html:feedback']), { timeout: 2000 });
    await settle();
    expect(t.seen).toHaveLength(2);
  });

  it("stays quiet for the app's own writes once settled", async () => {
    const t = setup();
    t.w.watch('s1', 'page.html');
    await settle(50);
    writeFileSync(t.page, '<h1>Edited in the pane</h1>');
    writeFileSync(t.feedback, '# Feedback · page.html\n');
    t.w.settle();
    await settle();
    expect(t.seen).toEqual([]);
  });

  it('keeps a watch until every view of the output closes', async () => {
    const t = setup();
    t.w.watch('s1', 'page.html');
    t.w.watch('s1', 'page.html');
    expect(t.resolved).toEqual(['s1:page.html']);
    t.w.unwatch('s1', 'page.html');
    await settle(50);
    writeFileSync(t.page, '<h1>Two</h1>');
    await vi.waitFor(() => expect(t.seen).toEqual(['s1:page.html:output']), { timeout: 2000 });
    t.w.unwatch('s1', 'page.html');
    await settle(50);
    writeFileSync(t.page, '<h1>Three, unwatched</h1>');
    await settle();
    expect(t.seen).toEqual(['s1:page.html:output']);
  });

  it('refuses a path the resolver refuses, and watches only the feedback file without an output', async () => {
    const t = setup();
    expect(() => t.w.watch('s1', 'bad.html')).toThrow('outside the project');
    const w = new OutputWatch(
      () => ({ feedback: t.feedback }),
      (_s, _p, kind) => t.seen.push(kind),
      { debounceMs: 30, pollMs: 40 },
    );
    watches.push(w);
    w.watch('s1', 'page.html');
    await settle(50);
    writeFileSync(t.page, '<h1>Two</h1>');
    writeFileSync(t.feedback, '# Feedback\n');
    await vi.waitFor(() => expect(t.seen).toEqual(['feedback']), { timeout: 2000 });
    await settle();
    expect(t.seen).toEqual(['feedback']);
  });
});
