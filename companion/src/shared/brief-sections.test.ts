import { describe, expect, it } from 'vitest';
import { briefLinks } from './brief-sections';

describe('briefLinks', () => {
  it('reads file links as paths and web links as URLs, with where each sits in the line', () => {
    const line = '2026-10-14 Three tiers → [D-001](<file:/pm/pricing/D-001 tiers.md>), see [thread](https://x.dev/t)';
    const [file, url] = briefLinks(line);
    expect(file).toMatchObject({ label: 'D-001', target: '/pm/pricing/D-001 tiers.md', kind: 'file' });
    expect(line.slice(file!.start, file!.end)).toBe('[D-001](<file:/pm/pricing/D-001 tiers.md>)');
    expect(url).toMatchObject({ label: 'thread', target: 'https://x.dev/t', kind: 'url' });
  });

  it('takes file:// and ~ paths, unescapes labels, and marks other destinations', () => {
    expect(briefLinks('[plan](file:///Users/pm/plan.md)')[0]).toMatchObject({ target: '/Users/pm/plan.md', kind: 'file' });
    expect(briefLinks('[v1](<file:~/PM/b.html>)')[0]).toMatchObject({ target: '~/PM/b.html', kind: 'file' });
    expect(briefLinks('[A \\[draft\\]](https://x.dev)')[0]!.label).toBe('A [draft]');
    expect(briefLinks('[D-1](decisions/D-1.md)')[0]!.kind).toBe('other');
    expect(briefLinks('No links [here] (at all)')).toEqual([]);
  });
});
