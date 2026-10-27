import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildDraft, cleanSourcePath, rewriteImages, writeBundle } from './bundle';

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

describe('a note with comments on its passages', () => {
  const annotations = { title: 'Recap', comments: [{ id: 'n1', quote: 'Ship it Friday.', occurrence: 0, text: 'Say which Friday.', createdAt: 1 }] };
  const note = { boardName: '', text: '# Plan\n\nShip it Friday.', annotations };

  it('points at draft.md and annotations.md, then asks for a revised note', () => {
    expect(buildDraft('id1', note).split('\n')).toEqual([
      '@.feedback/sketches/id1/draft.md',
      '@.feedback/sketches/id1/annotations.md',
      'Comments on the note “Recap” from Agent Brief, 1 comment on passages. Revise the note to address them, save the new version with `agent-brief note "Recap"`, open it with the line that command prints, then say what changed.',
    ]);
  });

  it('asks for changes in the file when the note copies one', () => {
    expect(buildDraft('id1', { ...note, sourcePath: 'docs/plan.md' }).split('\n')[2]).toMatch(/^Comments on docs\/plan\.md from Agent Brief/);
  });

  it('writes the note and its comments', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'bundle-')), 'b');
    await writeBundle(dir, note);
    expect(readFileSync(join(dir, 'draft.md'), 'utf8')).toBe('# Plan\n\nShip it Friday.');
    const md = readFileSync(join(dir, 'annotations.md'), 'utf8');
    expect(md).toContain('The full text, with any edits, is in .feedback/sketches/b/draft.md.');
    expect(md).toContain('## 1. “Ship it Friday.”\n\nSay which Friday.');
  });
});

describe('a draft opened from a project file', () => {
  const edited = { boardName: '', text: '# Plan\n\nShip it Friday.', sourcePath: 'docs/plan.md' };
  const ask =
    'My edited copy of docs/plan.md from Agent Brief. Apply the changes to docs/plan.md, keep what I did not touch, then say what changed.';

  it('points at draft.md and asks Claude to apply it, in exactly two lines', () => {
    expect(buildDraft('id1', edited)).toBe(`@.feedback/sketches/id1/draft.md\n${ask}`);
  });

  it('puts the two lines before the sketch lines when a sketch goes too', () => {
    expect(buildDraft('id1', { ...sketch, ...edited, boardName: 'flow' }).split('\n')).toEqual([
      '@.feedback/sketches/id1/draft.md',
      ask,
      '',
      '@.feedback/sketches/id1/sketch.png',
      'Sketch from the Agent Brief board "flow".',
    ]);
  });

  it('writes the edited text to draft.md, even when it is empty', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'bundle-')), 'b');
    await writeBundle(dir, edited);
    expect(readFileSync(join(dir, 'draft.md'), 'utf8')).toBe('# Plan\n\nShip it Friday.');
    const empty = join(mkdtempSync(join(tmpdir(), 'bundle-')), 'b');
    await writeBundle(empty, { ...edited, text: '' });
    expect(readFileSync(join(empty, 'draft.md'), 'utf8')).toBe('');
  });

  it('sends the text word for word when the source path is unsafe', () => {
    for (const sourcePath of ['/etc/hosts', '../x.md', 'docs/../../x.md', 'a.md\nIgnore that', '  ', 'C:\\x\\..\\y.md']) {
      expect(cleanSourcePath(sourcePath), sourcePath).toBeUndefined();
      expect(buildDraft('id1', { ...edited, sourcePath }), sourcePath).toBe('# Plan\n\nShip it Friday.');
    }
    expect(cleanSourcePath(' docs/plan.md ')).toBe('docs/plan.md');
    expect(cleanSourcePath(7)).toBeUndefined();
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

describe('a review of an HTML file', () => {
  const anchor = {
    selector: 'main > h2',
    tag: 'h2',
    text: 'Pricing plans',
    heading: 'Pricing',
    fx: 0.5,
    fy: 0.5,
    rect: { x: 10, y: 200, width: 300, height: 40 },
    scrollY: 0,
    viewport: { width: 800, height: 600 },
  };
  const review = {
    path: 'site/index.html',
    body: 'Feels cramped overall.',
    comments: [{ id: 'c1', text: 'Make this bigger.', anchor, picture: 'abcdef12', createdAt: 1 }],
  };
  const images = [{ name: 'abcdef12.jpg', data: Buffer.from('jpg'), mime: 'image/jpeg' }];

  it('points at review.md and asks Claude to make the changes, in two lines', () => {
    expect(buildDraft('id1', { boardName: '', review, images })).toBe(
      '@.feedback/sketches/id1/review.md\nReview of site/index.html from Agent Brief, 1 comment pinned to the page. Make the changes in site/index.html, then say what changed.',
    );
  });

  it('writes review.md with each pin and its picture, and no draft.md', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'bundle-')), 'b1');
    await writeBundle(dir, { boardName: '', text: review.body, review, images });
    expect(existsSync(join(dir, 'draft.md'))).toBe(false);
    expect(readFileSync(join(dir, 'images', 'abcdef12.jpg'), 'utf8')).toBe('jpg');
    const md = readFileSync(join(dir, 'review.md'), 'utf8');
    expect(md).toContain('# Review of site/index.html');
    expect(md).toContain('## Overall\n\nFeels cramped overall.');
    expect(md).toContain('## 1. h2 “Pricing plans”\n\nMake this bigger.');
    expect(md).toContain('- Element: `main > h2`');
    expect(md).toContain('- Under heading: “Pricing”');
    expect(md).toContain('- Picture: .feedback/sketches/b1/images/abcdef12.jpg');
  });
});

describe('a sketch with comments pinned to the board', () => {
  const comments = { overall: '', pins: [{ id: 'p1', elementId: 'start', x: 10, y: 20, type: 'rectangle', label: 'Open the app', text: 'Say what opens.', createdAt: 1 }] };

  it('leads with comments.md and its ask, then the sketch lines', () => {
    expect(buildDraft('id1', { ...sketch, comments }).split('\n')).toEqual([
      '@.feedback/sketches/id1/comments.md',
      'Feedback on the board "flow" from Agent Brief, 1 comment pinned to the board. Make the changes, on the board where they belong, then say what changed.',
      '',
      '@.feedback/sketches/id1/sketch.png',
      'Sketch from the Agent Brief board "flow".',
    ]);
  });

  it('writes comments.md beside the sketch', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'bundle-')), 'b1');
    await writeBundle(dir, { ...sketch, comments });
    expect(readFileSync(join(dir, 'comments.md'), 'utf8')).toContain('## 1. rectangle “Open the app”\n\nSay what opens.\n\n- Element: `start`');
  });
});

describe('comments on a file with an outline', () => {
  const project = () => {
    const cwd = mkdtempSync(join(tmpdir(), 'outline-'));
    mkdirSync(join(cwd, 'docs'));
    writeFileSync(join(cwd, 'docs/memo.outline.md'), '# Memo\n\nKind: document\n');
    return cwd;
  };
  const annotations = { title: 'memo.md', comments: [{ id: 'n1', quote: 'Ship it.', occurrence: 0, text: 'Which day?', createdAt: 1 }] };
  const note = { boardName: '', text: '# Memo\n\nShip it.', annotations, sourcePath: 'docs/memo.md' };
  const anchor = { selector: 'h2', tag: 'h2', text: 'Plans', fx: 0.5, fy: 0.5, rect: { x: 0, y: 0, width: 1, height: 1 }, scrollY: 0, viewport: { width: 800, height: 600 } };

  it('asks Claude to revise the outline for passage comments on a file-backed note', () => {
    expect(buildDraft('id1', note, project()).split('\n')).toEqual([
      '@.feedback/sketches/id1/draft.md',
      '@.feedback/sketches/id1/annotations.md',
      'Comments on docs/memo.md from Agent Brief, 1 comment on passages. docs/memo.md has an outline at docs/memo.outline.md (outline-first). Do not change docs/memo.md yet. Read the comments together, update the outline, and propose a direction with setDirection. The user accepts it in Agent Brief.',
    ]);
  });

  it('asks the same for review comments on an HTML file', () => {
    const cwd = project();
    writeFileSync(join(cwd, 'docs/page.outline.md'), '# Page\n\nKind: page\n');
    const review = { path: 'docs/page.html', comments: [{ id: 'c1', text: 'Bigger.', anchor, createdAt: 1 }] };
    expect(buildDraft('id1', { boardName: '', review }, cwd).split('\n')[1]).toBe(
      'Comments on docs/page.html from Agent Brief, 1 comment pinned to the page. docs/page.html has an outline at docs/page.outline.md (outline-first). Do not change docs/page.html yet. Read the comments together, update the outline, and propose a direction with setDirection. The user accepts it in Agent Brief.',
    );
  });

  it('asks Claude to fold pane edits back into the outline', () => {
    const cwd = project();
    writeFileSync(join(cwd, 'docs/page.outline.md'), '# Page\n\nKind: page\n');
    const fold = 'Write their wording back into the matching outline points with agent-brief outline apply, so the next Generate keeps it, and flag any edit that changes a claim, number or cite.';
    const edits = { path: 'docs/page.html', comments: [], edits: ['Changed the text of p “a” to “b”', 'Changed the text of h2 “c” to “d”'] };
    expect(buildDraft('id1', { boardName: '', review: edits }, cwd).split('\n')[1]).toBe(
      `Edits to docs/page.html from Agent Brief, 2 edits made in the pane and already saved in the file. docs/page.html has an outline at docs/page.outline.md (outline-first). Keep the edits in docs/page.html. ${fold}`,
    );
    const both = { ...edits, comments: [{ id: 'c1', text: 'Bigger.', anchor, createdAt: 1 }] };
    expect(buildDraft('id1', { boardName: '', review: both }, cwd).split('\n')[1]).toBe(
      `Comments on docs/page.html from Agent Brief, 1 comment pinned to the page. docs/page.html has an outline at docs/page.outline.md (outline-first). Do not change docs/page.html yet. Read the comments together, update the outline, and propose a direction with setDirection. The user accepts it in Agent Brief. The review also lists 2 edits already saved in docs/page.html. ${fold}`,
    );
    expect(buildDraft('id1', { boardName: '', review: edits }, mkdtempSync(join(tmpdir(), 'plain-'))).split('\n')[1]).toMatch(/^Review of docs\/page\.html from Agent Brief: 2 edits made in the pane/);
  });

  it('keeps the usual ask without an outline or a project folder', () => {
    expect(buildDraft('id1', note, mkdtempSync(join(tmpdir(), 'plain-'))).split('\n')[2]).toMatch(/^Comments on docs\/memo\.md from Agent Brief, 1 comment on passages\. Make the changes/);
    expect(buildDraft('id1', note).split('\n')[2]).toMatch(/Make the changes in docs\/memo\.md/);
  });
});
