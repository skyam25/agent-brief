import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BoardHost } from '../shared/ipc';
import { BoardController, parseScene } from './controller';
import { renderPng } from './png';

vi.mock('@excalidraw/excalidraw', () => ({
  CaptureUpdateAction: {},
  getSceneVersion: (elements: any[]) => elements.reduce((n, e) => n + e.version, 0),
  restore: (data: any) => data ?? { elements: [], files: {}, appState: {} },
  serializeAsJSON: (elements: any[], appState: any, files: any) => JSON.stringify({ elements: elements.filter((e) => !e.isDeleted), appState, files }),
  newElementWith: (e: any, patch: any) => ({ ...e, ...patch, version: e.version + 1 }),
}));
vi.mock('./ops', () => ({}));
vi.mock('./stack', () => ({}));
vi.mock('./viewport', () => ({ fitBoard() {} }));
vi.mock('./png', () => ({ renderPng: vi.fn(async () => new Uint8Array([1])) }));

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });
const element = (id: string, version = 1) => ({ id, version, versionNonce: version, isDeleted: false, type: 'rectangle', x: 0, y: 0, width: 10, height: 10 });
const json = (id: string) => JSON.stringify({ elements: [element(id)], appState: {}, files: {} });

function setup() {
  const disk = new Map([['A', { scene: json('a'), notes: 'A notes' }], ['B', { scene: json('b'), notes: 'B notes' }]]);
  const host = {
    loadBoard: async (board: string) => ({ ...disk.get(board)! }),
    saveBoard: async (board: string, scene: string) => { disk.get(board)!.scene = scene; },
    saveNotes: async (board: string, notes: string) => { disk.get(board)!.notes = notes; },
    setCurrent: async () => {},
    renameBoard: async (from: string, to: string) => { disk.set(to, disk.get(from)!); disk.delete(from); return to; },
  } as unknown as BoardHost;
  const controller = new BoardController(host, { board: 'A', notes: 'A notes', scene: parseScene(json('a')) });
  let elements: any[] = [element('a')];
  const api = {
    getSceneElementsIncludingDeleted: () => elements,
    getAppState: () => ({}),
    getFiles: () => ({}),
    updateScene: (update: any) => { if (update.elements) { elements = update.elements; controller.handleChange(elements); } },
    history: { clear() {} },
  };
  controller.attach(api as any);
  return { controller, api, disk };
}

describe('Send snapshots and board ownership', () => {
  it('clears the captured board after switching, leaving the visible board intact', async () => {
    vi.useFakeTimers();
    const { controller, api, disk } = setup();
    const sent = await controller.payload();
    await controller.switchTo('B');
    await controller.finishSend(sent, true);
    expect(api.getSceneElementsIncludingDeleted()).toEqual([element('b')]);
    expect(controller.notes).toBe('B notes');
    expect(JSON.parse(disk.get('A')!.scene).elements).toEqual([]);
    expect(disk.get('A')!.notes).toBe('');
  });

  it('retains strokes and notes edited during delivery', async () => {
    vi.useFakeTimers();
    const { controller, api } = setup();
    const sent = await controller.payload();
    api.updateScene({ elements: [element('a', 2), element('new')] });
    controller.setNotes('new notes');
    await controller.finishSend(sent, true);
    expect(api.getSceneElementsIncludingDeleted().every((e) => !e.isDeleted)).toBe(true);
    expect(controller.notes).toBe('new notes');
    await controller.flush();
  });

  it('freezes the scene and notes before the PNG render yields', async () => {
    vi.useFakeTimers();
    const { controller, api } = setup();
    let finish!: (png: Uint8Array) => void;
    vi.mocked(renderPng).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = controller.payload();
    await vi.waitFor(() => expect(finish).toBeDefined());
    api.updateScene({ elements: [element('new')] });
    controller.setNotes('new notes');
    finish(new Uint8Array([1]));
    const sent = await pending;
    expect((sent.scene as any).elements[0].id).toBe('a');
    expect(sent.notes).toBe('A notes');
    await controller.flush();
  });

  it('keeps audio on its original board and preserves clips recorded after Send', async () => {
    vi.useFakeTimers();
    const { controller } = setup();
    const clip = { name: 'first.webm', data: new Uint8Array([1]), startedAt: 1, mimeType: 'audio/webm' };
    controller.recorder.segments.push(clip);
    controller.recorder.recordedMs = 100;
    const sent = await controller.payload();
    controller.recorder.segments.push({ ...clip, name: 'later.webm' });
    controller.recorder.recordedMs = 200;
    await controller.switchTo('B');
    expect((await controller.payload()).segments).toEqual([]);
    await controller.finishSend(sent, false);
    await controller.switchTo('A');
    expect(controller.recorder.segments.map((s) => s.name)).toEqual(['later.webm']);
    expect(controller.recorder.recordedMs).toBe(100);
  });

  it('follows a rename while the Send is in flight', async () => {
    vi.useFakeTimers();
    const { controller, disk } = setup();
    controller.api!.updateScene({ elements: [element('a'), { ...element('old'), isDeleted: true }] as any });
    const sent = await controller.payload();
    await controller.renameBoard('Renamed');
    await controller.finishSend(sent, true);
    expect(JSON.parse(disk.get('Renamed')!.scene).elements).toEqual([]);
    expect(disk.has('A')).toBe(false);
  });
});
