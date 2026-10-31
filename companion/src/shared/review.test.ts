import { describe, expect, it } from 'vitest';
import { anchorLabel, cleanReview, reviewAsk, reviewMarkdown, reviewPictures, sitePage } from './review';
import { isLocalUrl } from './outputs';

const anchor = {
  selector: 'section#plans > div.card:nth-of-type(2) > h3',
  tag: 'H3',
  quote: 'Team   plan\n',
  text: 'Team plan',
  heading: 'Plans',
  fx: 1.4,
  fy: -2,
  rect: { x: 1, y: 2, width: 3, height: 4 },
  scrollY: 100,
  viewport: { width: 800, height: 600 },
};

describe('cleanReview', () => {
  it('keeps known fields, clamps the pin spot and lowercases the tag', () => {
    const review = cleanReview({
      path: 'site/index.html',
      extra: true,
      comments: [{ id: 'c1', text: 'Bigger', anchor: { ...anchor, junk: 1 }, picture: 'abcdef12', createdAt: 5, junk: 2 }],
    });
    expect(review).toEqual({
      path: 'site/index.html',
      comments: [{ id: 'c1', text: 'Bigger', anchor: { ...anchor, tag: 'h3', fx: 1, fy: 0 }, picture: 'abcdef12', createdAt: 5 }],
    });
  });

  it('drops comments with no selector or a bad id, and a picture id that is not one', () => {
    const review = cleanReview({
      path: 'a.html',
      comments: [
        { id: 'c1', text: '', anchor: { ...anchor, selector: '' } },
        { id: 'bad id!', text: '', anchor },
        { id: 'c3', text: 'ok', anchor, picture: '../x' },
      ],
    });
    expect(review!.comments.map((c) => c.id)).toEqual(['c3']);
    expect(review!.comments[0]!.picture).toBeUndefined();
  });

  it('is undefined without a path', () => {
    expect(cleanReview({ comments: [] })).toBeUndefined();
    expect(cleanReview('x')).toBeUndefined();
  });
});

describe('review text', () => {
  const review = { path: 'site/index.html', comments: [{ id: 'c1', text: '', anchor: { ...anchor, tag: 'h3' }, picture: 'abcdef12', createdAt: 1 }] };

  it('names a pin by its tag and the words it shows, selection first', () => {
    expect(anchorLabel(review.comments[0]!.anchor)).toBe('h3 “Team plan”');
    expect(anchorLabel({ ...anchor, tag: 'img', quote: undefined, text: undefined })).toBe('img');
  });

  it('lists the pictures comments use', () => {
    expect(reviewPictures(review)).toEqual(['abcdef12']);
    expect(reviewPictures(undefined)).toEqual([]);
  });

  it('says when a pin has no words, and leaves out a picture that did not make it', () => {
    const md = reviewMarkdown(review, () => undefined);
    expect(md).toContain('(No words. The pin marks this element.)');
    expect(md).toContain('- Selected text: “Team plan”');
    expect(md).not.toContain('Picture:');
  });

  it('asks for an overall note alone when there are no pins', () => {
    expect(reviewAsk({ path: 'a.html', comments: [], body: 'Darker.' })).toBe(
      'Review of a.html from Agent Brief, an overall note. Make the changes in a.html, then say what changed.',
    );
  });
});

describe('pane edits', () => {
  it('keeps edit lines and drops blanks', () => {
    expect(cleanReview({ path: 'a.html', comments: [], edits: ['Moved li', '', 3, 'Set color: red on h1'] })?.edits).toEqual(['Moved li', 'Set color: red on h1']);
    expect(cleanReview({ path: 'a.html', comments: [] })).not.toHaveProperty('edits');
  });

  it('lists edits in review.md as already saved', () => {
    const md = reviewMarkdown({ path: 'a.html', comments: [], edits: ['Moved li “Team”', 'Removed p'] }, () => undefined);
    expect(md).toContain('## Edited in the pane\n\nThese edits are already saved in a.html, in this order.\n\n- Moved li “Team”\n- Removed p');
  });

  it('asks Claude to check edits alone, or adds them to comments', () => {
    expect(reviewAsk({ path: 'a.html', comments: [], edits: ['x', 'y'] })).toBe(
      'Review of a.html from Agent Brief: 2 edits made in the pane, already saved in the file. Check them and tidy the markup where it needs it, then say what changed.',
    );
    expect(reviewAsk({ path: 'a.html', comments: [], body: 'Darker.', edits: ['x'] })).toBe(
      'Review of a.html from Agent Brief, an overall note, plus 1 edit already saved in the file. Make the changes in a.html, then say what changed.',
    );
  });

  it('ties pins to feedback items in review.md, and asks for a Review line or a new item', () => {
    const pin = (id: string, feedback?: number[]) => ({ id, text: 'Reads better', anchor: { ...anchor, tag: 'h3', fx: 0, fy: 0 }, createdAt: 1, ...(feedback ? { feedback } : {}) });
    const review = cleanReview({ path: 'site/index.html', comments: [pin('c1', [3, 3.5, -1, 6]), pin('c2', []), pin('c3')] })!;
    expect(review.comments.map((c) => c.feedback)).toEqual([[3, 6], [], undefined]);
    const md = reviewMarkdown(review, () => undefined);
    expect(md).toContain('- Feedback: items #3, #6 in site/index.html.feedback.md\n');
    expect(md).toContain('- Feedback: no item matches this element in site/index.html.feedback.md\n');
    expect(md.match(/- Feedback:/g)).toHaveLength(2);
    expect(reviewAsk(review)).toMatch(/feedback-items skill.*Review line.*new item/);
    expect(reviewAsk({ ...review, comments: [pin('c3')] })).not.toMatch(/feedback/);
  });
});

describe('pages and sites', () => {
  const comment = (id: string, page?: string) => ({ id, text: 'Tighter', anchor: { ...anchor, ...(page ? { page } : {}) }, createdAt: 1 });

  it('opens HTML files and dev servers on this Mac, and keys a site page by path and query', () => {
    for (const url of ['http://localhost:5173', 'https://127.0.0.1:8443/x', 'http://app.local/', 'http://web.localhost:4000']) expect(isLocalUrl(url)).toBe(true);
    for (const url of ['https://example.com', 'http://localhost.example.com', 'http://[::1]:3000/', 'file:///a.html', 'app.html']) expect(isLocalUrl(url)).toBe(false);
    expect(sitePage('http://localhost:5173/settings?tab=2#top')).toBe('/settings?tab=2');
  });

  it('keeps the page a pin sits on, and names it in review.md and the ask', () => {
    const review = cleanReview({ path: 'site/index.html', comments: [comment('a'), comment('b', 'site/about.html')] })!;
    expect(review.comments[1]!.anchor.page).toBe('site/about.html');
    expect(review.comments[0]!.anchor.page).toBeUndefined();
    expect(reviewMarkdown(review, () => undefined)).toContain('- Page: site/about.html\n- Element:');
    expect(reviewAsk(review)).toBe('Review of site/index.html from Agent Brief, 2 comments pinned to the pages. Make the changes in site/index.html and the other pages the comments name, then say what changed.');
  });

  it('asks Claude to find the source behind a running app', () => {
    const review = { path: 'http://localhost:5173/', comments: [comment('a', '/settings')] };
    expect(reviewMarkdown(review, () => undefined)).toContain('running app at http://localhost:5173/');
    expect(reviewAsk(review)).toBe('Review of the running app at http://localhost:5173/ from Agent Brief, 1 comment pinned to the pages. Find the source behind each pinned element in this project and make the changes, then say what changed.');
  });
});
