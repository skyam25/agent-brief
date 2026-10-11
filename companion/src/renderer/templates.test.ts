import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Template } from '../shared/ipc';
import { TemplateShelf } from './templates';

function fakeHost(initial: Template[]) {
  const disk = new Map(initial.map((t) => [t.id, t]));
  return {
    disk,
    listTemplates: vi.fn(async () => [...disk.values()]),
    saveTemplate: vi.fn(async (t: { id?: string; title: string; body: string }) => {
      const saved = { id: t.id ?? t.title.toLowerCase().replace(/\W+/g, '-'), title: t.title, body: t.body };
      disk.set(saved.id, saved);
      return saved;
    }),
    deleteTemplate: vi.fn(async (id: string) => void disk.delete(id)),
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('TemplateShelf', () => {
  it('creating one keeps unsaved edits to another', async () => {
    const host = fakeHost([{ id: 'a', title: 'A', body: 'old' }]);
    const shelf = new TemplateShelf(host);
    await shelf.load();
    shelf.edit('a', { body: 'new' });
    await shelf.create('B', 'b');
    expect(shelf.get('a')?.body).toBe('new');
    await shelf.flush();
    expect(host.disk.get('a')?.body).toBe('new');
    expect(shelf.templates.map((t) => t.title)).toEqual(['A', 'B']);
  });

  it('does not save a template while its name is empty', async () => {
    const host = fakeHost([{ id: 'a', title: 'A', body: 'x' }]);
    const shelf = new TemplateShelf(host);
    await shelf.load();
    shelf.edit('a', { title: ' ' });
    await shelf.flush();
    expect(host.saveTemplate).not.toHaveBeenCalled();
  });
});
