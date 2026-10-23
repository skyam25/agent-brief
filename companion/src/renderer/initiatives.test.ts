import { expect, it, vi } from 'vitest';
import type { CompanionApi, InitiativeDetail } from '../shared/ipc';
import { InitiativesStore } from './initiatives';

it('submits the edit baseline after an external push advances the displayed revision', async () => {
  let changed!: Parameters<CompanionApi['onInitiativesChanged']>[0];
  let detail = { initiative: { id: 'i', revision: 1, understanding: 'Original' }, history: [] } as unknown as InitiativeDetail;
  const updateInitiative = vi.fn(async () => ({ ok: false as const, message: 'stale revision', detail }));
  const host = {
    onInitiativesChanged: (fn: typeof changed) => { changed = fn; },
    getInitiative: async () => detail,
    updateInitiative,
  } as unknown as CompanionApi;
  const store = new InitiativesStore(host);
  await store.select('i');
  const revision = store.detail!.initiative.revision;
  detail = { ...detail, initiative: { ...detail.initiative, revision: 2, understanding: 'Agent edit' } };
  changed([{ ...detail.initiative, line: 'Agent edit' }]);
  await Promise.resolve();
  expect(store.detail!.initiative.revision).toBe(2);
  const result = await store.save({ understanding: 'User edit of original', revision });
  expect(updateInitiative).toHaveBeenCalledWith('i', { understanding: 'User edit of original', revision: 1 });
  expect(result.ok).toBe(false);
});
