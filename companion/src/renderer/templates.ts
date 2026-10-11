/** Holds the templates Write mode offers, with debounced saves while one is edited. */

import type { CompanionApi, Template } from '../shared/ipc';

export const TEMPLATE_SAVE_MS = 400;
const TEMPLATE_RETRY_MS = 2000;

type TemplateHost = Pick<CompanionApi, 'listTemplates' | 'saveTemplate' | 'deleteTemplate'>;

export class TemplateShelf {
  templates: Template[] = [];
  version = 0;
  saveError?: string;
  private readonly dirty = new Set<string>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly host: TemplateHost) {}

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    this.version++;
    for (const fn of this.listeners) fn();
  }

  async load(): Promise<void> {
    this.templates = await this.host.listTemplates();
    this.emit();
  }

  get(id: string | undefined): Template | undefined {
    return this.templates.find((t) => t.id === id);
  }

  /** Adds the new template without reloading, so edits to others not saved yet stay. */
  async create(title: string, body: string): Promise<Template> {
    const created = await this.host.saveTemplate({ title, body });
    this.templates = [...this.templates.filter((t) => t.id !== created.id), created].sort((a, b) => a.title.localeCompare(b.title));
    this.emit();
    return created;
  }

  /** Edits in place and saves after a pause. An empty title is kept on screen but not saved. */
  edit(id: string, change: Partial<Pick<Template, 'title' | 'body'>>): void {
    this.templates = this.templates.map((t) => (t.id === id ? { ...t, ...change } : t));
    this.save(id, TEMPLATE_SAVE_MS);
    this.emit();
  }

  private save(id: string, delay: number): void {
    this.dirty.add(id);
    clearTimeout(this.timers.get(id));
    this.timers.set(
      id,
      setTimeout(() => {
        this.timers.delete(id);
        void this.write(id);
      }, delay),
    );
  }

  remove(id: string): void {
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    this.dirty.delete(id);
    this.templates = this.templates.filter((t) => t.id !== id);
    void this.host.deleteTemplate(id);
    this.emit();
  }

  /** Writes every pending save now. Failed ones stay pending. */
  async flush(): Promise<void> {
    for (let attempt = 0; attempt < 2 && this.dirty.size > 0; attempt++) {
      for (const timer of this.timers.values()) clearTimeout(timer);
      this.timers.clear();
      await Promise.all([...this.dirty].map((id) => this.write(id)));
    }
  }

  private async write(id: string): Promise<void> {
    const t = this.get(id);
    this.dirty.delete(id);
    if (!t || !t.title.trim()) return;
    try {
      await this.host.saveTemplate(t);
      if (this.saveError && this.dirty.size === 0) {
        this.saveError = undefined;
        this.emit();
      }
    } catch (err) {
      if (!this.get(id)) return;
      this.saveError = (err as Error).message;
      if (!this.dirty.has(id)) this.save(id, TEMPLATE_RETRY_MS);
      this.emit();
    }
  }
}
