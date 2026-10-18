import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Template } from '../shared/ipc';
import { TEMPLATE_SAVE_MS, TemplateShelf } from './templates';

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

  it('retries failed saves and notifies the view when its error clears', async () => {
    const host = fakeHost([{ id: 'a', title: 'A', body: 'old' }]);
    host.saveTemplate.mockRejectedValueOnce(new Error('busy')).mockRejectedValueOnce(new Error('busy'));
    const shelf = new TemplateShelf(host);
    await shelf.load();
    const changed = vi.fn();
    shelf.subscribe(changed);
    shelf.edit('a', { body: 'new' });
    await shelf.flush();
    expect(shelf.saveError).toBe('busy');
    expect(host.disk.get('a')?.body).toBe('old');
    await vi.advanceTimersByTimeAsync(2000);
    expect(host.disk.get('a')?.body).toBe('new');
    expect(shelf.saveError).toBeUndefined();
    expect(changed).toHaveBeenCalledTimes(4); // edit, two failures, recovery
  });

  it('flush waits for a template save that has already started', async () => {
    const host = fakeHost([{ id: 'a', title: 'A', body: 'old' }]);
    let release!: () => void;
    host.saveTemplate.mockImplementationOnce((template) => new Promise<Template>((resolve) => {
      release = () => {
        const saved = { ...template, id: template.id! };
        host.disk.set(saved.id, saved);
        resolve(saved);
      };
    }));
    const shelf = new TemplateShelf(host);
    await shelf.load();
    shelf.edit('a', { body: 'new' });
    await vi.advanceTimersByTimeAsync(TEMPLATE_SAVE_MS);
    let finished = false;
    const flushing = shelf.flush().then(() => { finished = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(finished).toBe(false);
    release();
    await flushing;
    expect(host.disk.get('a')?.body).toBe('new');
  });

  it('deleting a template cancels its pending autosave', async () => {
    const host = fakeHost([{ id: 'a', title: 'A', body: 'old' }]);
    const shelf = new TemplateShelf(host);
    await shelf.load();
    shelf.edit('a', { body: 'new' });
    shelf.remove('a');
    await shelf.flush();
    await vi.advanceTimersByTimeAsync(TEMPLATE_SAVE_MS);
    expect(host.saveTemplate).not.toHaveBeenCalled();
    expect(host.disk.has('a')).toBe(false);
  });
});
