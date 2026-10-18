/** Holds the initiatives main pushes, and the one the Initiative view shows. */

import type { InitiativeSummary } from '../protocol';
import type { CompanionApi, InitiativeDetail, InitiativePatch, InitiativeSaveResult } from '../shared/ipc';

type InitiativesHost = Pick<CompanionApi, 'listInitiatives' | 'getInitiative' | 'createInitiative' | 'updateInitiative' | 'onInitiativesChanged'>;

/** What Discover hands a session. The mod's `/initiative discover` surveys the session's folder. */
export const DISCOVER_PROMPT = '/initiative discover';

/** Words in a text, for the Understanding counter. */
export const wordCount = (text: string): number => text.match(/\S+/g)?.length ?? 0;

export class InitiativesStore {
  /** Bumps on every change, as the snapshot React compares. */
  version = 0;
  list: InitiativeSummary[] = [];
  /** False until the first list arrives. */
  loaded = false;
  selectedId: string | undefined;
  detail: InitiativeDetail | undefined;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly host: InitiativesHost) {
    host.onInitiativesChanged((list) => {
      this.setList(list);
      if (this.selectedId) void this.loadDetail(this.selectedId).catch(() => undefined);
    });
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    this.version++;
    for (const fn of this.listeners) fn();
  }

  private setList(list: InitiativeSummary[]): void {
    this.list = list;
    this.loaded = true;
    if (this.selectedId && !list.some((i) => i.id === this.selectedId)) {
      this.selectedId = undefined;
      this.detail = undefined;
    }
    this.emit();
  }

  async load(): Promise<void> {
    this.setList(await this.host.listInitiatives());
    const id = this.selectedId ?? this.list[0]?.id;
    if (id) await this.select(id);
  }

  async select(id: string): Promise<void> {
    this.selectedId = id;
    this.emit();
    await this.loadDetail(id);
  }

  private async loadDetail(id: string): Promise<void> {
    const detail = await this.host.getInitiative(id);
    if (this.selectedId !== id) return;
    this.detail = detail;
    this.emit();
  }

  async create(title: string, folder: string): Promise<void> {
    const detail = await this.host.createInitiative({ title, folder });
    this.selectedId = detail.initiative.id;
    this.detail = detail;
    this.emit();
  }

  /** Saves against the shown revision. A conflict shows the brief as it is now. */
  async save(patch: Omit<InitiativePatch, 'revision'>): Promise<InitiativeSaveResult> {
    const shown = this.detail?.initiative;
    if (!shown) return { ok: false, message: 'No initiative is open' };
    const result = await this.host.updateInitiative(shown.id, { ...patch, revision: shown.revision });
    if (result.detail && this.selectedId === shown.id) {
      this.detail = result.detail;
      this.emit();
    }
    return result;
  }
}
