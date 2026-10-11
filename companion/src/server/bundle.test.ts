import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildDraft, writeBundle } from './bundle';

const sketch = { png: Buffer.from('png'), scene: { elements: [] }, boardName: 'flow' };

describe('buildDraft', () => {
  it('points at the sketch and names the board', () => {
    expect(buildDraft('id1', sketch)).toBe('@.feedback/sketches/id1/sketch.png\nSketch from the Agent Brief board "flow".');
  });

  it('sends a written draft alone word for word', () => {
    expect(buildDraft('id1', { boardName: '', text: '  Fix the login redirect.\n\nKeep the cookie.  ' })).toBe(
      'Fix the login redirect.\n\nKeep the cookie.',
    );
  });

  it('puts a written draft before the sketch lines', () => {
    expect(buildDraft('id1', { ...sketch, text: 'Build this flow.' }).split('\n')).toEqual([
      'Build this flow.',
      '',
      '@.feedback/sketches/id1/sketch.png',
      'Sketch from the Agent Brief board "flow".',
    ]);
  });
});

describe('writeBundle', () => {
  it('writes only draft.md for a written draft alone', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'bundle-')), 'b');
    await writeBundle(dir, { boardName: '', text: 'hello' });
    expect(readFileSync(join(dir, 'draft.md'), 'utf8')).toBe('hello');
    expect(existsSync(join(dir, 'sketch.png'))).toBe(false);
  });

  it('writes the sketch and the draft together', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'bundle-')), 'b');
    await writeBundle(dir, { ...sketch, text: 'hello' });
    expect(existsSync(join(dir, 'sketch.png'))).toBe(true);
    expect(existsSync(join(dir, 'board.excalidraw'))).toBe(true);
    expect(existsSync(join(dir, 'draft.md'))).toBe(true);
  });
});
