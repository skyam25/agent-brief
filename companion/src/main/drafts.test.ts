import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Draft } from '../shared/ipc';
import { draftImages, draftPreview, draftTitle, referencedImages, sortDrafts } from '../shared/drafts';
import { deliveryImages, DraftStore } from './drafts';

const temp = () => mkdtempSync(join(tmpdir(), 'drafts-'));

const draft = (id: string, patch: Partial<Draft> = {}): Draft => ({
  id,
  body: `body ${id}`,
  status: 'note',
  rank: 0,
  createdAt: 1,
  updatedAt: 1,
  ...patch,
});

describe('DraftStore', () => {
  it('saves, lists, renames boards and removes drafts', () => {
    const store = new DraftStore(temp());
    store.save(draft('a', { board: 'flow' }));
    store.save(draft('b'));
    expect(store.list().map((d) => d.id).sort()).toEqual(['a', 'b']);
    expect(store.get('a')?.board).toBe('flow');

    store.renameBoard('flow', 'checkout');
    expect(store.get('a')?.board).toBe('checkout');

    store.remove('a');
    expect(store.get('a')).toBeUndefined();
    expect(readdirSync(store.dir)).toEqual(['b.json']);
  });

  it('refuses ids that are unsafe as file names and drops unknown fields', () => {
    const store = new DraftStore(temp());
    expect(() => store.save(draft('../x'))).toThrow(/draft id/);
    expect(() => store.save({ ...draft('a'), status: 'sent' })).toThrow(/status/);
    const saved = store.save({ ...draft('a'), extra: 1 } as Draft);
    expect(saved).not.toHaveProperty('extra');
  });

  it('keeps the session a note is filed under, and drops it when unfiled', () => {
    const store = new DraftStore(temp());
    store.save(draft('a', { sessionId: 's-1' }));
    expect(store.get('a')?.sessionId).toBe('s-1');
    expect(store.save(draft('a')).sessionId).toBeUndefined();
    expect(store.get('a')).not.toHaveProperty('sessionId');
    expect(() => store.save({ ...draft('b'), sessionId: 7 } as unknown as Draft)).toThrow(/sessionId/);
  });

  it('skips a damaged file instead of failing the whole list', () => {
    const store = new DraftStore(temp());
    store.save(draft('a'));
    writeFileSync(join(store.dir, 'bad.json'), '{');
    expect(store.list().map((d) => d.id)).toEqual(['a']);
  });
});

describe('sortDrafts', () => {
  it('puts Ready drafts first by rank, then notes newest first', () => {
    const sorted = sortDrafts([
      draft('old-note', { updatedAt: 1 }),
      draft('second', { status: 'ready', rank: 2 }),
      draft('new-note', { updatedAt: 5 }),
      draft('first', { status: 'ready', rank: 1 }),
    ]);
    expect(sorted.map((d) => d.id)).toEqual(['first', 'second', 'new-note', 'old-note']);
  });
});

const png = 'data:image/png;base64,iVBORw0KGgo=';

describe('DraftStore pictures', () => {
  it('keeps valid attachments and drops an empty set', () => {
    const store = new DraftStore(temp());
    expect(store.save(draft('a', { attachments: { shot01: png } })).attachments).toEqual({ shot01: png });
    expect(store.get('a')?.attachments).toEqual({ shot01: png });
    expect(store.save(draft('a', { attachments: {} }))).not.toHaveProperty('attachments');
  });

  it('refuses bad ids, kinds, sizes and counts', () => {
    const store = new DraftStore(temp());
    const save = (attachments: unknown) => () => store.save({ ...draft('a'), attachments } as Draft);
    expect(save(['x'])).toThrow(/attachments/);
    expect(save({ 'Bad-ID': png })).toThrow(/picture ids/);
    expect(save({ shot01: 'data:image/svg+xml;base64,AAAA' })).toThrow(/png, jpeg, webp or gif/);
    expect(save({ shot01: 42 })).toThrow(/png, jpeg, webp or gif/);
    expect(save({ shot01: `data:image/png;base64,${'A'.repeat(6 * 1024 * 1024)}` })).toThrow(/under 6 MB/);
    const many = Object.fromEntries(Array.from({ length: 41 }, (_, i) => [`shot${String(i).padStart(2, '0')}`, png]));
    expect(save(many)).toThrow(/at most 40 pictures/);
  });
});

describe('deliveryImages', () => {
  it('decodes data URLs into files named by id and type', () => {
    const files = deliveryImages([
      { id: 'shot01', data: png },
      { id: 'shot02', data: 'data:image/jpeg;base64,/9j/' },
    ]);
    expect(files.map((f) => [f.name, f.mime])).toEqual([
      ['shot01.png', 'image/png'],
      ['shot02.jpg', 'image/jpeg'],
    ]);
    expect(files[0].data.subarray(1, 4).toString()).toBe('PNG');
  });

  it('skips a malformed entry with a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const files = deliveryImages([
      { id: 'shot01', data: 'data:text/plain;base64,AAAA' },
      { id: 'BAD', data: png },
      { id: 'shot03', data: png },
    ]);
    expect(files.map((f) => f.name)).toEqual(['shot03.png']);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('gives nothing for no pictures', () => {
    expect(deliveryImages(undefined)).toEqual([]);
  });
});

describe('referencedImages and draftImages', () => {
  it('lists referenced ids in order, each once', () => {
    const body = 'A ![one](att:shot01)\n\n![](att:shot02 "title") and ![again](att:shot01) ![x](https://e.com/a.png)';
    expect(referencedImages(body)).toEqual(['shot01', 'shot02']);
  });

  it('hands over only referenced attachments that exist', () => {
    const d = draft('a', { body: '![](att:shot02) ![](att:shot09)', attachments: { shot01: png, shot02: png } });
    expect(draftImages(d)).toEqual([{ id: 'shot02', data: png }]);
    expect(draftImages(draft('b'))).toEqual([]);
  });
});

describe('draftTitle', () => {
  it('strips list, task, quote and emphasis markers', () => {
    expect(draftTitle('- **Fix** the _login_ `redirect`')).toBe('Fix the login redirect');
    expect(draftTitle('- [ ] Ship it')).toBe('Ship it');
    expect(draftTitle('1. First step')).toBe('First step');
    expect(draftTitle('> Quoted ask')).toBe('Quoted ask');
    expect(draftTitle('## Heading')).toBe('Heading');
    expect(draftTitle('See [the docs](https://x.dev) for user_id')).toBe('See the docs for user_id');
  });

  it('skips lines that are only a picture or a table rule', () => {
    expect(draftTitle('![shot](att:shot01)\n\nThe form breaks')).toBe('The form breaks');
    expect(draftTitle('- ![shot](att:shot01)\nNext')).toBe('Next');
    expect(draftTitle('|---|---|\n| a | b |')).toBe('a · b');
    expect(draftTitle('```ts\nconst x = 1;')).toBe('const x = 1;');
  });

  it('shortens a long line', () => {
    expect(draftTitle('x'.repeat(80), 10)).toBe(`${'x'.repeat(9)}…`);
  });
});

describe('draftPreview', () => {
  it('is the second worded line without Markdown', () => {
    expect(draftPreview('# Checkout polish\n\n- Tighten the **header**')).toBe('Tighten the header');
    expect(draftPreview('Title\n\n![shot](att:shot01)\n\n| --- |\n\n1. Next step')).toBe('Next step');
    expect(draftPreview('Only a title')).toBeUndefined();
  });
});
