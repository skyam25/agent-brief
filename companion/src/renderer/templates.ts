/** Holds the templates Write mode offers, with debounced saves while one is edited. */

import type { CompanionApi, Template } from '../shared/ipc';
import { SaveQueue } from './save-queue';

export const TEMPLATE_SAVE_MS = 400;
const TEMPLATE_RETRY_MS = 2000;

type TemplateHost = Pick<CompanionApi, 'listTemplates' | 'saveTemplate' | 'deleteTemplate'>;

export class TemplateShelf {
  templates: Template[] = [];
  version = 0;
  private readonly saves = new SaveQueue((id) => this.write(id), () => this.emit(), TEMPLATE_SAVE_MS, TEMPLATE_RETRY_MS);
  get saveError(): string | undefined { return this.saves.error; }
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
    this.saves.schedule(id);
    this.emit();
  }

  remove(id: string): void {
    this.saves.cancel(id);
    this.templates = this.templates.filter((t) => t.id !== id);
    void this.host.deleteTemplate(id);
    this.emit();
  }

  /** Writes every pending save now. Failed ones stay pending. */
  flush(): Promise<void> {
    return this.saves.flush();
  }

  /** A title is required to persist a template; incomplete edits stay on screen. */
  private async write(id: string): Promise<boolean> {
    const template = this.get(id);
    if (!template || !template.title.trim()) return false;
    await this.host.saveTemplate(template);
    return true;
  }
}
