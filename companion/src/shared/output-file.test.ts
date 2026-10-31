import { describe, expect, it } from 'vitest';
import { opensInApp, refSurface } from './output-file';

describe('refSurface', () => {
  it('names where each kind of ref opens', () => {
    expect(refSurface('docs/a.html')).toBe('review');
    expect(refSurface('http://localhost:5173/x')).toBe('review');
    expect(refSurface('docs/memo.outline.md')).toBe('outline');
    expect(refSurface('docs/memo.md')).toBe('note');
    expect(refSurface('https://example.com/a.html')).toBe('link');
    expect(refSurface('file:///a.html')).toBe('link');
    expect(refSurface('report.pdf')).toBe('file');
    expect(refSurface('.outline.md')).toBe('note');
  });

  it('keeps links and other files out of the panel', () => {
    expect(['a.md', 'a.htm', 'a.outline.md', 'http://app.local/'].every(opensInApp)).toBe(true);
    expect(['a.pdf', 'a.docx', 'https://example.com'].some(opensInApp)).toBe(false);
  });
});
