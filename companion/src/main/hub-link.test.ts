import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SyncHub } from '../web/sync-hub';
import { HubLink } from './hub-link';
import { BoardStore } from './store';

const el = (id: string, version = 1, extra: Record<string, unknown> = {}) => ({ id, version, versionNonce: 1, type: 'rectangle', ...extra });

function setup(current = 'shown') {
  const store = new BoardStore(mkdtempSync(join(tmpdir(), 'hub-')));
  store.create('shown');
  store.saveScene('shown', JSON.stringify({ type: 'excalidraw', elements: [el('a')] }));
  store.create('other');
  const hub = new SyncHub();
  const toRenderer = vi.fn();
  const link = new HubLink({ hub, store, currentBoard: () => current, toRenderer });
  return { store, hub, link, toRenderer };
}

describe('HubLink', () => {
  it('seeds every board from disk', () => {
    const { hub } = setup();
    expect(hub.boards().map((b) => b.name).sort()).toEqual(['other', 'shown']);
    expect(hub.snapshot('shown').map((e) => e.id)).toEqual(['a']);
  });

  it('sends changes to the shown board to the renderer, not back for the Mac\'s own', () => {
    const { hub, link, toRenderer } = setup();
    link.pushed('shown', [el('a', 2)]);
    expect(toRenderer).not.toHaveBeenCalled();
    hub.apply('shown', 'web-1', [el('b')]);
    expect(toRenderer).toHaveBeenCalledWith('shown', [expect.objectContaining({ id: 'b' })]);
  });

  it('writes web changes to boards the Mac does not show', () => {
    const { hub, link, store, toRenderer } = setup();
    hub.apply('other', 'web-1', [el('w', 1, { x: 5 })]);
    expect(toRenderer).not.toHaveBeenCalled();
    link.flush();
    const saved = JSON.parse(store.load('other').scene!);
    expect(saved.elements.map((e: { id: string }) => e.id)).toEqual(['w']);
    expect(saved.type).toBe('excalidraw');
  });

  it('seeds boards created or renamed later', () => {
    const { hub, store } = setup();
    store.create('fresh');
    store.rename('other', 'renamed');
    expect(hub.has('fresh')).toBe(true);
    expect(hub.has('renamed')).toBe(true);
  });

  it('takes whole saves and ignores malformed elements', () => {
    const { hub, link } = setup();
    link.saved('other', JSON.stringify({ elements: [el('s'), { id: 'bad' }] }));
    link.saved('other', 'not json');
    expect(hub.snapshot('other').map((e) => e.id)).toEqual(['s']);
  });
});
