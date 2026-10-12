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
