import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildDraft, rewriteImages, writeBundle } from './bundle';

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

const shot = { name: 'shot01.png', data: Buffer.from('img'), mime: 'image/png' };
const at = (name: string) => `@.feedback/sketches/id1/images/${name}`;

describe('rewriteImages', () => {
  it('turns a picture into an @ line with its alt text', () => {
    expect(rewriteImages('Fix this.\n\n![login form](att:shot01)', 'id1', [shot])).toBe(`Fix this.\n\n${at('shot01.png')} — login form`);
  });

  it('leaves out the dash when there is no alt text', () => {
    expect(rewriteImages('![](att:shot01)', 'id1', [shot])).toBe(at('shot01.png'));
  });

  it('gives a picture inside a paragraph its own line and keeps the words around it', () => {
    expect(rewriteImages('Before ![a](att:shot01) after', 'id1', [shot]).split('\n')).toEqual(['Before', `${at('shot01.png')} — a`, 'after']);
  });

  it('keeps the list marker of an item that holds only a picture', () => {
    expect(rewriteImages('- first\n- ![](att:shot01)', 'id1', [shot])).toBe(`- first\n- ${at('shot01.png')}`);
  });

  it('keeps a picture in a table cell', () => {
    expect(rewriteImages('| ![a|b](att:shot01) | x |', 'id1', [shot])).toBe(`| ${at('shot01.png')} — a\\|b | x |`);
  });

  it('keeps only the alt text of a picture with no file', () => {
    expect(rewriteImages('See ![the form](att:gone01) now', 'id1', [shot]).split('\n')).toEqual(['See', 'the form', 'now']);
  });

  it('leaves text without pictures alone', () => {
    expect(rewriteImages('  plain\n\n![web](https://e.com/a.png)', 'id1', [shot])).toBe('  plain\n\n![web](https://e.com/a.png)');
  });
});

describe('pictures in a delivery', () => {
  it('points the prompt at each picture, before the sketch lines', () => {
    const lines = buildDraft('id1', { ...sketch, text: 'Match this ![mock](att:shot01)', images: [shot] }).split('\n');
    expect(lines.slice(0, 4)).toEqual(['Match this', `${at('shot01.png')} — mock`, '', '@.feedback/sketches/id1/sketch.png']);
  });

  it('writes the pictures and a draft.md that matches the prompt', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'bundle-')), 'id1');
    const input = { boardName: '', text: 'Look ![mock](att:shot01)', images: [shot] };
    await writeBundle(dir, input);
    expect(readFileSync(join(dir, 'images', 'shot01.png'), 'utf8')).toBe('img');
    expect(readFileSync(join(dir, 'draft.md'), 'utf8')).toBe(buildDraft('id1', input));
  });
});
