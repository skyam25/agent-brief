import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatTemplate, parseTemplate, slugify, STARTER_TEMPLATES, TemplateStore } from './templates';

const temp = () => mkdtempSync(join(tmpdir(), 'templates-'));

describe('TemplateStore', () => {
  it('starts a new install with the starter templates, once', () => {
    const dataDir = temp();
    const store = new TemplateStore(dataDir);
    expect(store.list().map((t) => t.title)).toEqual([
      'Bug report',
      'Decision',
      'Interview notes',
      'Launch plan',
      'One-pager',
      'Prototype',
      'Status update',
      'User story',
    ]);
    store.remove('one-pager');
    expect(new TemplateStore(dataDir).list()).toHaveLength(STARTER_TEMPLATES.length - 1);
  });

  it('upgrades an older install, keeping edited and hand-made templates', () => {
    const dir = join(temp(), 'templates');
    mkdirSync(dir);
    const old = { id: 'plan-first', title: 'Plan first', body: 'Plan {{goal}}\n' };
    writeFileSync(join(dir, 'plan-first.md'), formatTemplate(old));
    writeFileSync(join(dir, 'feature.md'), formatTemplate({ title: 'Feature', body: 'my own words' }));
    writeFileSync(join(dir, 'standup.md'), 'Yesterday: {{done}}\n');
    const starter = { id: 'one-pager', title: 'One-pager', body: '# {{name}}\n' };
    const retired = [old, { id: 'feature', title: 'Feature', body: 'Build {{it}}\n' }];
    const store = new TemplateStore(join(dir, '..'), [starter], retired);
    expect(store.list().map((t) => t.id)).toEqual(['feature', 'one-pager', 'standup']);
    store.remove('one-pager');
    expect(new TemplateStore(join(dir, '..'), [starter], retired).list().map((t) => t.id)).toEqual(['feature', 'standup']);
  });

  it('creates under a free id from the title and keeps the id on edits', () => {
    const store = new TemplateStore(temp(), []);
    const a = store.save({ title: 'Code review!', body: 'Review {{pr}}' });
    const b = store.save({ title: 'Code review', body: 'again' });
    expect([a.id, b.id]).toEqual(['code-review', 'code-review-2']);
    store.save({ id: a.id, title: 'PR review', body: 'Review {{pr}} closely' });
    expect(readFileSync(join(store.dir, 'code-review.md'), 'utf8')).toBe('---\ntitle: PR review\n---\nReview {{pr}} closely');
    expect(store.list().map((t) => t.title)).toEqual(['Code review', 'PR review']);
  });

  it('reads files written by hand, with or without front matter', () => {
    const store = new TemplateStore(temp(), []);
    writeFileSync(join(store.dir, 'standup.md'), 'Yesterday: {{done}}\n');
    expect(store.list()).toEqual([{ id: 'standup', title: 'standup', body: 'Yesterday: {{done}}\n' }]);
  });

  it('refuses unsafe ids and empty titles', () => {
    const store = new TemplateStore(temp(), []);
    expect(() => store.save({ id: '../x', title: 'x', body: '' })).toThrow(/template id/);
    expect(() => store.save({ title: '  ', body: '' })).toThrow(/title/);
  });
});

describe('parseTemplate', () => {
  it('splits front matter from the body', () => {
    expect(parseTemplate('a', '---\ntitle: Bug report\n---\nBody\n')).toEqual({ id: 'a', title: 'Bug report', body: 'Body\n' });
  });
});

describe('slugify', () => {
  it('makes a file-safe id', () => {
    expect(slugify('  Ship it: v2!! ')).toBe('ship-it-v2');
    expect(slugify('!!!')).toBe('template');
  });
});
