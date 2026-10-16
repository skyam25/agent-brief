import { describe, expect, it } from 'vitest';
import { anchorLabel, cleanReview, reviewAsk, reviewMarkdown, reviewPictures } from './review';

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
});
